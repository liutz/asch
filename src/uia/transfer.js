var assert = require('assert')
var async = require('async')
var bignum = require('bignumber')
var mathjs = require('mathjs')

function Transfer() {
  this.create = function (data, trs) {
    trs.amount = 0
    trs.recipientId = data.recipientId
    trs.asset.uiaTransfer = {
      currency: data.currency,
      amount: data.amount
    }
    return trs
  }

  this.calculateFee = function (trs, sender) {
    return library.base.block.calculateFee()
  }

  this.verify = function (trs, sender, cb) {
    var isAddress = /^[0-9]{1,21}$/g
    if (!trs.recipientId || !isAddress.test(trs.recipientId)) return cb("Invalid recipient")
    if (trs.amount != 0) return setImmediate(cb, 'Invalid transaction amount')

    var asset = trs.asset.uiaTransfer
    var amount = asset.amount
    var bnAmount = bignum(amount)
    if (bnAmount.lt(1) || bnAmount.gt('1e32')) return setImmediate(cb, 'Invalid asset transfer amount')

    library.model.getAssetByName(asset.currency, function (err, assetDetail) {
      if (err) return cb('Database error: ' + err)
      if (!assetDetail) return cb('Cannot issue unregistered asset')
      if (assetDetail.writeoff) return cb('Asset already writeoff')

      // if (sender.address == assetDetail.issuerId) return cb()

      var aclTable = assetDetail.acl == 0 ? 'acl_black' : 'acl_white'

      library.model.checkAcl(aclTable, asset.currency, sender.address, trs.recipientId, function (err, isInList) {
        if (err) return cb('Database error when query acl: ' + err)
        if ((assetDetail.acl == 0) == isInList) return cb('Permission not allowed')
        cb()
      })
    })
  }

  this.process = function (trs, sender, cb) {
    setImmediate(cb, null, trs)
  }

  this.getBytes = function (trs) {
    var buffer = Buffer.concat([
      new Buffer(trs.asset.uiaTransfer.currency, 'utf8'),
      new Buffer(trs.asset.uiaTransfer.amount, 'utf8')
    ])
    return buffer
  }

  this.apply = function (trs, block, sender, cb) {
    var transfer = trs.asset.uiaTransfer
    async.series([
      function (next) {
        library.model.updateAssetBalance(transfer.currency, '-' + transfer.amount, sender.address, next)
      },
      function (next) {
        library.model.updateAssetBalance(transfer.currency, transfer.amount, trs.recipientId, next)
      }
    ], cb)
  }

  this.undo = function (trs, block, sender, cb) {
    var transfer = trs.asset.uiaTransfer
    async.series([
      function (next) {
        library.model.updateAssetBalance(transfer.currency, transfer.amount, sender.address, next)
      },
      function (next) {
        library.model.updateAssetBalance(transfer.currency, '-' + transfer.amount, trs.recipientId, next)
      }
    ], cb)
  }

  this.applyUnconfirmed = function (trs, sender, cb) {
    var transfer = trs.asset.uiaTransfer
    var key = transfer.currency + ':' + sender.address
    var balance = library.tmdb.get(key) || '0'
    var surplus = bignum(balance).sub(transfer.amount)
    if (surplus.lt(0)) return setImmediate('Asset balance not enough')
    library.tmdb.set(key, surplus.toString())

    var key2 = transfer.currency + ':' + trs.recipientId
    var balance2 = library.tmdb.get(key2) || '0'
    library.tmdb.set(key2, bignum(balance2).plus(transfer.amount).toString())

    setImmediate(cb)
  }

  this.undoUnconfirmed = function (trs, sender, cb) {
    var transfer = trs.asset.uiaTransfer
    var key = transfer.currency + ':' + sender.address
    var balance = library.tmdb.get(key) || '0'
    library.tmdb.set(key, bignum(balance).plus(transfer.amount).toString())

    var key2 = transfer.currency + ':' + trs.recipientId
    var balance2 = library.tmdb.get(key2) || '0'
    assert(bignum(balance2).gte(transfer.amount))
    library.tmdb.set(key2, bignum(balance2).sub(transfer.amount).toString())
    setImmediate(cb)
  }

  this.objectNormalize = function (trs) {
    var report = library.scheme.validate(trs.asset.uiaTransfer, {
      object: true,
      properties: {
        currency: {
          type: 'string',
          minLength: 1,
          maxLength: 16
        },
        amount: {
          type: 'string',
          minLength: 1,
          maxLength: 33
        }
      },
      required: ['currency', 'amount']
    })

    if (!report) {
      throw Error('Can\'t parse transfer: ' + library.scheme.getLastError())
    }

    return trs
  }

  this.dbRead = function (raw) {
    if (!raw.transfer_currency) {
      return null
    } else {
      var asset = {
        transactionId: raw.t_id,
        currency: raw.transfers_currency,
        amount: raw.transfers_amount
      }

      return { asset: asset }
    }
  }

  this.dbSave = function (trs, cb) {
    var currency = trs.asset.uiaTransfer.currency
    var amount = trs.asset.uiaTransfer.amount
    var values = {
      transactionId: trs.id,
      currency: currency,
      amount: amount
    }
    library.model.add('transfers', values, cb)
  }

  this.ready = function (trs, sender) {
    if (sender.multisignatures.length) {
      if (!trs.signatures) {
        return false
      }
      return trs.signatures.length >= sender.multimin - 1
    } else {
      return true
    }
  }
}

module.exports = new Transfer