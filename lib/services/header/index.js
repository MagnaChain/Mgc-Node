'use strict';

var BaseService = require('../../service');
var inherits = require('util').inherits;
var Encoding = require('./encoding');
var index = require('../../');
var log = index.log;
var utils = require('../../utils');
var async = require('async');
var BN = require('bn.js');
var consensus = require('bcoin').consensus;
var assert = require('assert');
var constants = require('../../constants');
var bcoin = require('bcoin');
var HEADER_NUM = 2000;

var HeaderService = function(options) {

  BaseService.call(this, options);

  this._tip = null;
  this._p2p = this.node.services.p2p;
  this._db = this.node.services.db;
  this._hashes = [];

  this.subscriptions = {};
  this.subscriptions.block = [];
  this._checkpoint = options.checkpoint || 2000; // set to -1 to resync all headers.
  this.GENESIS_HASH = constants.BITCOIN_GENESIS_HASH[this.node.network];
  this._lastHeader = null;
  this._initialSync = true;
  this._originalHeight = 0;
  this._lastHeaderCount = 2000;

  this._slowMode = options.slowMode;
};

inherits(HeaderService, BaseService);

HeaderService.dependencies = [ 'p2p', 'db' ];

HeaderService.MAX_CHAINWORK = new BN(1).ushln(256);
HeaderService.STARTING_CHAINWORK = '0000000000000000000000000000000000000000000000000000000100010001';

HeaderService.prototype.subscribe = function(name, emitter) {
  //log.info("HEADER_SERVICE: subscribe");
  this.subscriptions[name].push(emitter);
  log.info(emitter.remoteAddress, 'subscribe:', 'header/' + name, 'total:', this.subscriptions[name].length);
};

HeaderService.prototype.unsubscribe = function(name, emitter) {
  //log.info("HEADER_SERVICE: unsubscribe");
  var index = this.subscriptions[name].indexOf(emitter);

  if (index > -1) {
    this.subscriptions[name].splice(index, 1);
  }

  log.info(emitter.remoteAddress, 'unsubscribe:', 'header/' + name, 'total:', this.subscriptions[name].length);

};

HeaderService.prototype.getAPIMethods = function() {
  //log.info("HEADER_SERVICE: getAPIMethods");
  var methods = [
    ['getAllHeaders', this, this.getAllHeaders, 0],
    ['getBestHeight', this, this.getBestHeight, 0],
    ['getBlockHeader', this, this.getBlockHeader, 1]
  ];

  return methods;

};

HeaderService.prototype.getCurrentDifficulty = function() {
  //log.info("HEADER_SERVICE: getCurrentDifficulty");
  var target = bcoin.mining.common.getTarget(this._lastHeader.bits);
  return bcoin.mining.common.getDifficulty(target);
};

HeaderService.prototype.getAllHeaders = function(callback) {
  log.info("HEADER_SERVICE: getAllHeaders");
  var self = this;
  var start = self._encoding.encodeHeaderHeightKey(0);
  var end = self._encoding.encodeHeaderHeightKey(self._tip.height + 1);
  var allHeaders = new utils.SimpleMap();

  var criteria = {
    gte: start,
    lt: end
  };

  var stream = self._db.createReadStream(criteria);

  var streamErr;

  stream.on('error', function(error) {
    streamErr = error;
  });

  stream.on('data', function(data) {
    var header = self._encoding.decodeHeaderValue(data.value);
    allHeaders.set(header.hash, header, header.height);
  });

  stream.on('end', function() {

    if (streamErr) {
      return streamErr;
    }

    callback(null, allHeaders);

  });
};

HeaderService.prototype.getBlockHeader = function(arg, callback) {
  log.info("HEADER_SERVICE: getBlockHeader");
  if (utils.isHeight(arg)) {
    return this._getHeader(arg, null, callback);
  }

  return this._getHeader(null, arg, callback);

};

HeaderService.prototype.getBestHeight = function() {
  log.info("HEADER_SERVICE: getBestHeight");
  return this._tip.height;
};

HeaderService.prototype._adjustTipBackToCheckpoint = function() {
  log.info("HEADER_SERVICE: _adjustTipBackToCheckpoint");
  this._originalHeight = this._tip.height;

  if (this._checkpoint === -1 || this._tip.height < this._checkpoint) {
    log.info("HEADER_SERVICE: set _tip.height = 0,_tip.hash = this.GENESIS_HASH");
    this._tip.height = 0;
    this._tip.hash = this.GENESIS_HASH;

  } else {
    log.info("HEADER_SERVICE: this._tip.height -= this._checkpoint");
    this._tip.height -= this._checkpoint;

  }

};

HeaderService.prototype._setGenesisBlock = function(callback) {
  log.info("HEADER_SERVICE: _setGenesisBlock");
  assert(this._tip.hash === this.GENESIS_HASH, 'Expected tip hash to be genesis hash, but it was not.');

  var genesisHeader = {
    hash: this.GENESIS_HASH,
    height: 0,
    chainwork: HeaderService.STARTING_CHAINWORK,
    version: 1,
    prevHash: new Array(65).join('0'),
    timestamp: 1231006505,
    nonce: 2083236893,
    bits: 0x1d00ffff,
    merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
  };

  this._lastHeader = genesisHeader;

  var dbOps = [
    {
      type: 'put',
      key: this._encoding.encodeHeaderHeightKey(0),
      value: this._encoding.encodeHeaderValue(genesisHeader)
    },
    {
      type: 'put',
      key: this._encoding.encodeHeaderHashKey(this.GENESIS_HASH),
      value: this._encoding.encodeHeaderValue(genesisHeader)
    }
  ];

  this._db.batch(dbOps, callback);

};

HeaderService.prototype.start = function(callback) {
  //log.info("HEADER_SERVICE: start");
  var self = this;

  async.waterfall([
    function(next) {
      self._db.getPrefix(self.name, next);
    },
    function(prefix, next) {
      self._encoding = new Encoding(prefix);
      self._db.getServiceTip(self.name, next);
    },
    function(tip, next) {
      log.info("HEADER_SERVICE: get tip from db tip is: " + JSON.stringify(tip) );
      self._tip = tip;
	
      self._adjustTipBackToCheckpoint();

      async.waterfall([

        function(next) {

          if (self._tip.height === 0) {
            return self._setGenesisBlock(next);
          }

          next();

        },

        function(next) {
          self._adjustHeadersForCheckPointTip(next);
        }

      ], function(err) {

        if (err) {
          return next(err);
        }

        next();

      });
    }

  ], function(err) {

      if (err) {
        return callback(err);
      }

      // set block worker queue, concurrency 1
	  log.info("HEADER_SERVICE: set _blockProcessor " );
      self._blockProcessor = async.queue(self._processBlocks.bind(self));

      self._setListeners();
      self._bus = self.node.openBus({remoteAddress: 'localhost-header'});
      callback();

  });

};

HeaderService.prototype.stop = function(callback) {

  callback();

};

HeaderService.prototype._startHeaderSubscription = function() {
  log.info("HEADER_SERVICE: _startHeaderSubscription");
  if (this._subscribedHeaders) {
    return;
  }
  this._subscribedHeaders = true;
  log.info('HEADER_SERVICE: subscribed to p2p headers.');
  this._bus.on('p2p/headers', this._onHeaders.bind(this));
  this._bus.subscribe('p2p/headers');

};

HeaderService.prototype.getPublishEvents = function() {
  //log.info("HEADER_SERVICE: getPublishEvents");
  return [
    {
      name: 'header/block',
      scope: this,
      subscribe: this.subscribe.bind(this, 'block'),
      unsubscribe: this.unsubscribe.bind(this, 'block')
    }
  ];

};

HeaderService.prototype._queueBlock = function(block) {
 log.debug('HEADER_SERVICE ################ : start push processing block: ' + block.rhash() + ' prev hash: ' + bcoin.util.revHex(block.prevHash) );
 
  var self = this;

  self._blockProcessor.push(block, function(err) {

    if (err) {
      return self._handleError(err);
    }

    log.debug('HEADER_SERVICE: pushed processing block: ' + block.rhash() + ' prev hash: ' + bcoin.util.revHex(block.prevHash));
  });

};

HeaderService.prototype._processBlocks = function(block, callback) {
  log.info("HEADER_SERVICE: _processBlocks");
  var self = this;

  if (self.node.stopping || self._reorging) {
    return callback();
  }

  self.getBlockHeader(block.rhash(), function(err, header) {
    if(err) {
      return self._handleError(err);
    }

    if (header) {
      log.debug('HEADER_SERVICE: block already exists in data set.');
      return callback();
    }

    self._persistHeader(block, callback);
  });

};

HeaderService.prototype._persistHeader = function(block, callback) {
  log.info("HEADER_SERVICE: _persistHeader");
  var self = this;

  if (!self._detectReorg(block)) {
    return self._syncBlock(block, callback);
  }

  self._reorging =  true;
  self.emit('reorg');

  self._handleReorg(block, function(err) {

    if(err) {
      return callback(err);
    }
    log.info("HEADER_SERVICE############### : _persistHeader call _startSync");
    self._startSync();
    callback();
  });
};

HeaderService.prototype._formatHeader = function(block) {
  log.info("HEADER_SERVICE: _formatHeader");
  var header = block.toHeaders().toJSON();
  header.timestamp = header.time;
  //var header = block.toHeader().toJSON();
  //header.timestamp = header.time;
  header.prevHash = header.prevBlock;
  return header;

};

HeaderService.prototype._syncBlock = function(block, callback) {
  log.info("HEADER_SERVICE: _syncBlock");
  var self = this;

  var header = self._formatHeader(block);
  log.debug('HEADER_SERVICE: new block: ' + block.rhash());

  var dbOps = self._getDBOpForLastHeader(header);
  dbOps = dbOps.concat(self._onHeader(header));
  self._saveHeaders(dbOps, callback);
};

HeaderService.prototype._broadcast = function(block) {
  log.info("HEADER_SERVICE: _broadcast");
  for (var i = 0; i < this.subscriptions.block.length; i++) {
    this.subscriptions.block[i].emit('header/block', block);
  }
};

HeaderService.prototype._onHeader = function(header) {
  //log.info("################## HeaderService.prototype._onHeader header.height is " + header.height );
  if (!header) {
    return;
  }

  header.height = this._lastHeader.height + 1;
  header.chainwork = this._getChainwork(header, this._lastHeader).toString(16, 64);

  if (!header.timestamp) {
    header.timestamp = header.time;
  }

  this._lastHeader = header;
  this._tip.height = header.height;
  this._tip.hash = header.hash;

  return [
    {
      type: 'put',
      key: this._encoding.encodeHeaderHashKey(header.hash),
      value: this._encoding.encodeHeaderValue(header)
    },
    {
      type: 'put',
      key: this._encoding.encodeHeaderHeightKey(header.height),
      value: this._encoding.encodeHeaderValue(header)
    }
  ];

};

HeaderService.prototype._transformHeaders = function(headers) {
  //log.info("$$$$$$$$$$$$$$$$$ HeaderService.prototype._transformHeaders");
  var ret = [];
  for(var i = 0; i < headers.length; i++) {
    var hdr = headers[i].toObject();
    if (headers[i+1]) {
      hdr.nextHash = headers[i+1].hash;
    }
    ret.push(hdr);
  }
  return ret;
};

HeaderService.prototype._getDBOpForLastHeader = function(nextHeader) {
  // we need to apply the next hash value on the last-processed header

  // delete operation for the last header already in the db.
  // then put operation for the updated last header (with the next hash)
  log.info("HEADER_SERVICE: _getDBOpForLastHeader");
  this._lastHeader.nextHash = nextHeader.hash;
  var keyHash = this._encoding.encodeHeaderHashKey(this._lastHeader.hash);

  assert(this._lastHeader.height >= 0, 'Trying to save a header with incorrect height.');

  var keyHeight = this._encoding.encodeHeaderHeightKey(this._lastHeader.height);
  var value = this._encoding.encodeHeaderValue(this._lastHeader);
  return [
    {
      type: 'del',
      key: keyHash
    },
    {
      type: 'del',
      key: keyHeight
    },
    {
      type: 'put',
      key: keyHash,
      value: value
    },
    {
      type: 'put',
      key: keyHeight,
      value: value
    }
  ];
};

HeaderService.prototype._onHeaders = function(headers) {
  log.info("HEADER_SERVICE ######## : _onHeadersssssss");
  var self = this;

  if (headers.length === 0) {
    self._onHeadersSave(function(err) {
      if (err) {
        return self._handleError(err);
      }
    });
  }

  // used to tell the header sync loop when to stop
  self._lastHeaderCount = headers.length;

  log.debug('HEADER_SERVICE ############## : Received: ' + headers.length + ' header(s).');

  if (!headers[0]) {
    return;
  }

  var dbOps = self._getDBOpForLastHeader(headers[0]);

  var transformedHeaders = self._transformHeaders(headers);
  //log.info('HEADER_SERVICE ##############: transformedHeaders[0] is: ' + JSON.stringify(transformedHeaders[0]));
  for(var i = 0; i < transformedHeaders.length; i++) {

    var header = transformedHeaders[i];

    assert(self._lastHeader.hash === header.prevHash, 'headers not in order: ' + self._lastHeader.hash +
      ' -and- ' + header.prevHash + ' Last header at height: ' + self._lastHeader.height);

    var ops = self._onHeader(header);

    dbOps = dbOps.concat(ops);

  }

  self._saveHeaders(dbOps, function(err) {
    if (err) {
      return self._handleError(err);
    }
  });

};

HeaderService.prototype._handleError = function(err) {
  log.error('HEADER_SERVICE: _handleError ' + err);
  this.node.stop();
};

HeaderService.prototype._saveHeaders = function(dbOps, callback) {
  log.info("HEADER_SERVICE: _saveHeaders");
  var self = this;
  var tipOps = utils.encodeTip(self._tip, self.name);

  dbOps.push({
    type: 'put',
    key: tipOps.key,
    value: tipOps.value
  });

  self._db.batch(dbOps, function(err) {
    if(err) {
      return callback(err);
    }
    self._onHeadersSave(callback);
  });
};

HeaderService.prototype._onHeadersSave = function(callback) {
  log.info("HEADER_SERVICE: _onHeadersSave");
  var self = this;

  self._logProgress();

  if (!self._syncComplete()) {
    self._sync();
    return callback();
  }

  self._endHeaderSubscription(); // we don't need headers any more
  self._startBlockSubscription(); // we need new blocks coming tu us aynchronuously

  self._setBestHeader();

  if (!self._initialSync) {
    return callback();
  }

  // this will happen after an inital start up and sync -and- also after a chain reorg
  log.info('HEADER_SERVICE: sync head complete!!!!');
  self._initialSync = false;

  // this is where the other services are called to let them know we have a good set of headers
  async.eachSeries(self.node.services, function(service, next) {
    if (service.onHeaders) {
      return service.onHeaders.call(service, next);
    }
    next();
  }, function(err) {

    if (err) {
      return callback(err);
    }

    self.emit('reorg complete');
    self._reorging = false;
    callback();

  });

};

HeaderService.prototype._endHeaderSubscription = function() {
  log.info("HEADER_SERVICE: _endHeaderSubscription");
  if (this._subscribedHeaders) {
    this._subscribedHeaders = false;
    log.info('HEADER_SERVICE: p2p header subscription no longer needed, unsubscribing.');
    this._bus.unsubscribe('p2p/headers');
  }
};

HeaderService.prototype._startBlockSubscription = function() {
  log.info("HEADER_SERVICE: _startBlockSubscription");
  if (this._subscribedBlock) {
    return;
  }

  this._subscribedBlock = true;

  //log.info('HEADER_SERVICE: starting p2p block subscription.');
  this._bus.on('p2p/block', this._queueBlock.bind(this));
  this._bus.subscribe('p2p/block');

};

HeaderService.prototype._syncComplete = function() {

  // we always ask for the max number of headers, which is 2000.
  // so any response with < 2000 means we have reached the end of the headers list.
  // we could make an extra call if the number of total headers is multiple of 2000.
  log.info("HEADER_SERVICE: _syncComplete");
  return this._lastHeaderCount < 2000;

};

HeaderService.prototype._setBestHeader = function() {
  log.info("HEADER_SERVICE: _setBestHeader");
  var bestHeader = this._lastHeader;
  log.debug('HEADER_SERVICE: ' + bestHeader.hash + ' is the best block hash.');
};

HeaderService.prototype._getHeader = function(height, hash, callback) {
  log.info("HEADER_SERVICE: _getHeader");
  var self = this;

  /*jshint -W018 */
  if (!hash && !(height >= 0)) {
    /*jshint +W018 */
    return callback(new Error('invalid arguments'));
  }

  if (height === self._lastHeader.height || hash === self._lastHeader.hash) {
    return callback(null, self._lastHeader);
  }

  var key;
  if (hash) {
    key = self._encoding.encodeHeaderHashKey(hash);
  } else {
    key = self._encoding.encodeHeaderHeightKey(height);
  }

  self._db.get(key, function(err, data) {

    if (err) {
      return callback(err);
    }

    if (!data) {
      return callback();
    }

    callback(null, self._encoding.decodeHeaderValue(data));

  });

};

// we aren't go to get fancy with this, we are just going to wipe out the
// last 2000 or so headers and re-ask our peer for the last set of headers.
HeaderService.prototype._detectReorg = function(block) {
  log.info("HEADER_SERVICE: _detectReorg");
  //return bcoin.util.revHex(block.prevBlock) !== this._lastHeader.hash;
  return block.hash !== this._lastHeader.hash;
};

HeaderService.prototype._handleReorg = function(block, callback) {
  log.info("HEADER_SERVICE: _handleReorg");
  var self = this;

  log.warn('HEADER_SERVICE: Reorganization detected, current tip hash: ' +
    self._tip.hash + ', new block causing the reorg: ' + block.rhash());

  // at this point, we have a block that does not directly link to our
  // last header. This is all we know for sure. We may not have this block's
  // previous blocks either, which means we need to go out and re-retrieve
  // a list of the latest headers and gather those blocks. If the peer hasn't
  // completed its own reorganization, we may need to defer the rest of the system
  // reorg until we get a list of headers that correctly links from this block
  // all the way back to the genesis block.

  // first, we'll adjust the tip back to the last checkpoint just like we do when
  // the service starts up.
  self._adjustTipBackToCheckpoint();

  // then, we'll get the last header from the database which will nuke out all the
  // headers that are greater than new tip height.
  self._adjustHeadersForCheckPointTip(callback);

};

HeaderService.prototype._setListeners = function() {
  //log.info("HEADER_SERVICE: _setListeners");
  this._p2p.on('bestHeight', this._onBestHeight.bind(this));
};

HeaderService.prototype._onBestHeight = function(height) {
  log.info('HEADER_SERVICE: _onBestHeight Best Height is: ' + height);
  this._bestHeight = height;
  this._startSync();
};

HeaderService.prototype._startSync = function() {
  log.info("HEADER_SERVICE: _startSync");
  var self = this;

  // remove all listeners
  // ensure the blockProcessor is finished processing blocks (empty queue)
  // then proceed with gathering new set(s) of headers

  // if our tip height is less than the best height of this peer, then:
  // 1. the peer is not fully synced.
  // 2. the peer has reorg'ed and we need to handle this

  self._initialSync = true;
  log.debug('HEADER_SERVICE ########## : starting sync routines, ensuring no pre-exiting subscriptions to p2p blocks.');
  self._removeAllSubscriptions();

  async.retry(function(next) {

    next(self._blockProcessor.length() !== 0);

  }, function() {

    self._reorging = false;
    var numNeeded = Math.max(self._bestHeight, self._originalHeight) - self._tip.height;

    // common case
    if (numNeeded > 0) {
      log.info('HEADER_SERVICE #############: Gathering: ' + numNeeded + ' ' + 'header(s) from the peer-to-peer network.');
      return self._sync();
    }

    // next most common case
    if (numNeeded === 0) {
      log.info('HEADER_SERVICE: we seem to be already synced with the peer.');
      return self._onHeadersSave(function(err) {
        if(err) {
          return self._handleError(err);
        }
      });
    }

    // very uncommon! when a peer is not sync'ed or has reorg'ed
    self._handleLowTipHeight();

  });

};

HeaderService.prototype._removeAllSubscriptions = function() {
  //log.info("HEADER_SERVICE: _removeAllSubscriptions");
  this._bus.unsubscribe('p2p/headers');
  this._bus.unsubscribe('p2p/block');
  this._subscribedBlock = false;
  this._subscribedHeaders = false;
  this._bus.removeAllListeners();
};

// this should fire in edge cases where a new peer is not quite synced
HeaderService.prototype._findReorgConditionInNewPeer = function(callback) {
  log.info("HEADER_SERVICE: _findReorgConditionInNewPeer");
  var self = this;

  var newPeerHeaders = new utils.SimpleMap();
  var headerCount = 0;

  self.getAllHeaders(function(err, allHeaders) {

    if (err) {
      return callback(err);
    }

    log.warn('HEADER_SERVICE: re-subscribing to p2p headers to gather new peer\'s headers.');
    self._subscribedHeaders = true;
    self._bus.subscribe('p2p/headers');
    self._bus.on('p2p/headers', function(headers) {

      headers.forEach(function(header) {
        newPeerHeaders.set(header.hash, header);
        headerCount++;
      });

      if (headerCount < self._bestHeight) {
        return self._getP2PHeaders(headers[headers.length - 1].hash);
      }

      // We should have both sets of headers, work from latest header to oldest and find the common header.
      // Use the new set since we know this is a shorter list.
      var reorgInfo = { commonHeader: null, blockHash: null };

      for(var i = newPeerHeaders.length - 1; i >= 0; i--) {

        var newHeader = newPeerHeaders.getIndex(i);
        var oldHeader = allHeaders.get(newHeader.hash);

        if (oldHeader) {

          // we found a common header, but no headers that at a greater height, this peer is not synced
          if (!reorgInfo.blockHash) {
            return callback();
          }

          reorgInfo.commonHeader = oldHeader;
          return callback(null, reorgInfo);
        }

        reorgInfo.blockHash = newHeader.hash;
      }

      // nothing matched...
      // at this point, we should wonder if we are connected to the wrong network
      assert(true, 'We tried to find a common header between current set of headers ' +
        'and the new peer\'s set of headers, but there were none. This should be impossible ' +
          ' if the new peer is using the same genesis block.');
    });

    self._getP2PHeaders(self.GENESIS_HASH);

  });

};

HeaderService.prototype._handleLowTipHeight = function() {
  log.info("HEADER_SERVICE: _handleLowTipHeight");
  var self = this;

  log.warn('HEADER_SERVICE: Connected Peer has a best height (' + self._bestHeight + ') which is lower than our tip height (' +
    self._tip.height + '). This means that this peer is not fully synchronized with the network -or- the peer has reorganized itself.' +
    ' Checking the new peer\'s headers for a reorganization event.');

  self._findReorgConditionInNewPeer(function(err, reorgInfo) {

    if (err) {
      return self._handleError(err);
    }

    // Our peer is not yet sync'ed.
    // We will just turn on our block subscription and wait until we get a block we haven't seen
    if (!reorgInfo) {
      log.info('HEADER_SERVICE: it appears that our peer is not yet synchronized with the network '  +
        '(we have a strict superset of the peer\'s blocks). We will wait for more blocks to arrive...');
      return self._onHeadersSave(function(err) {
        if (err) {
          return self._handleError(err);
        }
      });
    }

    // our peer has reorg'ed to lower overall height.
    // we should get the first block after the split, reorg back to this height - 1 and then continue.
    // we should still have no listeners for anything, blocks, headers, etc. at this point
	log.info("HEADER_SERVICE: ################# _handleLowTipHeight call p2p.getP2PBlock ");
    self._p2p.getP2PBlock({
      filter: {
        startHash: reorgInfo.commonHeader.hash,
        endHash: 0
      },
      blockHash: reorgInfo.blockHash
    }, function(block) {
      log.info("HEADER_SERVICE: ################# _handleLowTipHeight call p2p.getP2PBlock callback");
      self._initialSync = true;

      self._handleReorg(block, reorgInfo.commonHeader, function(err) {

        if(err) {
          self._handleError(err);
        }

        // run start sync again. This time we should be back on track.
        self._startSync();

      });
    });

  });


};

HeaderService.prototype._logProgress = function() {
  log.info("HEADER_SERVICE: _logProgress");
  if (!this._initialSync || this._lastTipHeightReported === this._tip.height) {
    return;
  }

  var progress;
  var bestHeight = Math.max(this._bestHeight, this._lastHeader.height);

  if (bestHeight === 0) {
    progress = 0;
  } else {
    progress = (this._tip.height/bestHeight*100.00).toFixed(2);
  }

  log.info('HEADER_SERVICE: download progress: ' + this._tip.height + '/' +
    bestHeight + '  (' + progress + '%)');

  this._lastTipHeightReported = this._tip.height;
};

HeaderService.prototype._getP2PHeaders = function(hash) {
  log.info("HEADER_SERVICE: _getP2PHeaders startHash: " + hash);
  var self = this;
  self._p2p.getHeaders({ startHash: hash });

};

HeaderService.prototype._sync = function() {
  log.info("HEADER_SERVICE: _sync");
  this._startHeaderSubscription(); // ensures only one listener will ever be registered
  this._getP2PHeaders(this._tip.hash);

};

HeaderService.prototype.getEndHash = function(tip, blockCount, callback) {
  log.info("HEADER_SERVICE: getEndHash");
  assert(blockCount >= 1, 'HEADER_SERVICE: block count to getEndHash must be at least 1.');

  var self = this;

  var numResultsNeeded = Math.min((self._tip.height - tip.height), blockCount + 1);

  if (numResultsNeeded === 0 && self._tip.hash === tip.hash) {
    return callback();
  }

  if (numResultsNeeded <= 0) {
    return callback(new Error('HEADER_SERVICE: block service is mis-aligned '));
  }

  var startingHeight = tip.height + 1;
  var start = self._encoding.encodeHeaderHeightKey(startingHeight);
  var end = self._encoding.encodeHeaderHeightKey(startingHeight + blockCount);
  var results = [];

  var criteria = {
    gte: start,
    lte: end
  };

  var stream = self._db.createReadStream(criteria);

  var streamErr;

  stream.on('error', function(error) {
    streamErr = error;
  });

  stream.on('data', function(data) {
    results.push(self._encoding.decodeHeaderValue(data.value).hash);
  });

  stream.on('end', function() {

    if (streamErr) {
      return streamErr;
    }

    assert(results.length === numResultsNeeded, 'getEndHash returned incorrect number of results.');

    var index = numResultsNeeded - 1;
    var endHash =  index <= 0 || !results[index] ? 0 : results[index];

    if (self._slowMode) {
      return setTimeout(function() {
        callback(null, results[0], endHash);
      }, self._slowMode);
    }

    callback(null, results[0], endHash);

  });

};

HeaderService.prototype.getLastHeader = function() {
  log.info("HEADER_SERVICE: getLastHeader");
  assert(this._lastHeader, 'Last header should be populated.');
  return this._lastHeader;
};

HeaderService.prototype._adjustHeadersForCheckPointTip = function(callback) {
  log.info("HEADER_SERVICE: _adjustHeadersForCheckPointTip");
  var self = this;

  var removalOps = [];

  var start = self._encoding.encodeHeaderHeightKey(self._tip.height);
  var end = self._encoding.encodeHeaderHeightKey(0xffffffff);

  log.info('HEADER_SERVICE: Getting last header synced at height: ' + self._tip.height);

  var criteria = {
    gte: start,
    lte: end
  };

  var stream = self._db.createReadStream(criteria);

  var streamErr;
  stream.on('error', function(error) {
    streamErr = error;
  });

  stream.on('data', function(data) {
    var header  = self._encoding.decodeHeaderValue(data.value);

    // any records with a height greater than our current tip height can be scheduled for removal
    // because they will be replaced shortly
    // and for every height record, we must also remove its hash record
    if (header.height > self._tip.height) {
      removalOps.push({
        type: 'del',
        key: data.key
      });
      removalOps.push({
        type: 'del',
        key: self._encoding.encodeHeaderHashKey(header.hash)
      });
      return;
    }

    if (header.height === self._tip.height) {
      self._lastHeader = header;
    }

  });

  stream.on('end', function() {

    if (streamErr) {
      return streamErr;
    }

    assert(self._lastHeader, 'The last synced header was not in the database.');
    self._tip.hash = self._lastHeader.hash;
    self._tip.height = self._lastHeader.height;
    self._db.batch(removalOps, callback);

  });

};

HeaderService.prototype._getChainwork = function(header, prevHeader) {
  //log.info("$$$$$$$$$$$$$$$$$ HeaderService.prototype._getChainwork");
  var prevChainwork = new BN(new Buffer(prevHeader.chainwork, 'hex'));

  return this._computeChainwork(header.bits, prevChainwork);
};

HeaderService.prototype._computeChainwork = function(bits, prev) {
  //log.info("$$$$$$$$$$$$$$$$$ HeaderService.prototype._computeChainwork");
  var target = consensus.fromCompact(bits);

  if (target.isNeg() || target.cmpn(0) === 0) {
    return new BN(0);
  }

  var proof =  HeaderService.MAX_CHAINWORK.div(target.iaddn(1));

  if (!prev) {
    return proof;
  }

  return proof.iadd(prev);

};

module.exports = HeaderService;

