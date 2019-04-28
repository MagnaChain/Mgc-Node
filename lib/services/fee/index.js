'use strict';

var BaseService = require('../../service');
var inherits = require('util').inherits;
var BitcoreRPC = require('bitcoind-rpc');
var index = require('../../');
var log = index.log;

var FeeService = function(options) {
  log.info('FEE_SERVICE: ############### FeeService constructor ');
  this._config = options.rpc || {
    user: 'user',
    pass: 'pwd',
    host: 'localhost',
    protocol: 'http',
    port: 8332
  };
  BaseService.call(this, options);
  this._client = new BitcoreRPC(this._config);
};

inherits(FeeService, BaseService);

FeeService.dependencies = [];

FeeService.prototype.start = function() {
  return this.node.network.port - 1;
};

FeeService.prototype.start = function(callback) {
  callback();
};

FeeService.prototype.stop = function(callback) {
  callback();
};

FeeService.prototype.getAPIMethods = function() {
  return [
    ['estimateFee', this, this.estimateFee, 1]
  ];
};

FeeService.prototype.estimateFee = function(blocks, callback) {
  log.info('FEE_SERVICE: ############### estimateFee ');
  this._client.estimateFee(blocks || 4, function(err, res) {

    if (err) {
      return callback(err);
    }

    if (!res) {
      callback();
    }

    callback(null, res.result);

  });

};

module.exports = FeeService;

