const { Base } = require('./base');
const { IOTA_DEPTH, IOTA_MWM } = require('../config');

const DEFAULT_OPTIONS = {
  index: 1,
  isCurrent: true,
  queue: null,
  seed: null,
  iota: null
};

class BasePage extends Base {
  constructor(options) {
    const opts = Object.assign(
      {},
      DEFAULT_OPTIONS,
      {
        logIdent: 'PAGES'
      },
      options
    );
    super(opts);
    this.opts = opts;
    this.addresses = {};
  }

  async init() {
    return await this.sync();
  }

  async sync(force = false, priority) {
    await this.syncAddresses(priority, force);
    if (!Object.keys(this.addresses).length) {
      await this.getNewAddress();
      await this.syncAddresses(priority, true);
    }
    return this;
  }

  asJson() {
    const { index, isCurrent, seed } = this.opts;
    return {
      index,
      isCurrent,
      seed,
      addresses: this.addresses,
      jobs: this.getJobs()
    };
  }

  applyAddresses(addresses) {
    const pastAddresses = Object.keys(this.addresses).filter(
      a => !addresses.includes(a)
    );
    const startIndex = pastAddresses.length;
    addresses.forEach((address, keyIndex) => {
      if (!this.addresses[address]) {
        this.addresses[address] = {
          address,
          keyIndex: keyIndex + startIndex,
          security: 2,
          balance: 0,
          rawBalance: 0,
          spent: null,
          transactions: {}
        };
      }
    });
    this.onChange();
  }

  getJobs() {
    return Object.values(this.opts.queue.jobs).filter(
      j => j.opts && j.opts.page === this.opts.index
    );
  }

  getNewAddress(total = 1, callback = null) {
    const { iota, seed, queue, index, isCurrent } = this.opts;

    return new Promise((resolve, reject) => {
      const addressPromise = () =>
        new Promise((resolve, reject) => {
          iota.api.getNewAddress(
            seed,
            {
              index: Object.keys(this.addresses).length,
              total
            },
            async (err, addresses) => {
              if (err) {
                reject(err);
              }
              addresses = Array.isArray(addresses) ? addresses : [addresses];
              this.applyAddresses(addresses);
              await this.restoreAddresses(
                addresses,
                `Attaching new addresses`,
                'Could not attach new addresses'
              );
              await this.syncAddresses(100);
              callback && (await callback(addresses));
              resolve(addresses);
            }
          );
        });

      const { job } = queue.add(addressPromise, isCurrent ? 15 : 5, {
        page: index,
        type: 'NEW_ADDRESS',
        description: `Adding new addresses`
      });
      job.on('finish', resolve);
      job.on('failed', err => {
        this.log('Could not add addresses', err);
        reject(err);
      });
    });
  }

  syncAddresses(priority, cachedOnly) {
    const { iota, seed, queue, index, isCurrent } = this.opts;

    return new Promise((resolve, reject) => {
      let cached = [];

      const addressPromise = () =>
        new Promise((resolve, reject) => {
          iota.api.ext.getAddresses(
            seed,
            (err, addresses) => {
              if (!err) {
                cached = addresses;
                this.applyAddresses(addresses);
              }
            },
            async (err, addresses) => {
              if (err) {
                return reject(err);
              }
              const missingAddresses = cached.filter(
                c => !addresses.includes(c)
              );
              if (missingAddresses.length) {
                await this.restoreAddresses(missingAddresses);
              }
              cached.length < addresses.length &&
                this.applyAddresses(addresses);
              resolve(this);
            },
            cachedOnly
          );
        });

      const { job } = queue.add(
        addressPromise,
        priority || (isCurrent ? 15 : 5),
        {
          page: index,
          type: 'SYNC_ADDRESSES',
          description: `${cachedOnly ? 'Loading' : 'Syncing'} addresses`,
          cachedOnly
        }
      );
      job.on('finish', resolve);
      job.on('failed', err => {
        this.log('Could not sync page addresses', err);
        reject(err);
      });
    });
  }

  sendTransfers(transfers, inputs, message, messageFail, priority) {
    const { iota, seed, queue, index, isCurrent } = this.opts;

    const sendPromise = () =>
      new Promise((resolve, reject) => {
        iota.api.sendTransfer(
          seed,
          IOTA_DEPTH,
          IOTA_MWM,
          transfers,
          { inputs },
          (err, result) => {
            if (err) {
              return reject(err);
            }
            resolve(result);
          }
        );
      });

    return new Promise((resolve, reject) => {
      const { job } = queue.add(
        sendPromise,
        priority || (isCurrent ? 20 : 10),
        {
          page: index,
          type: 'SEND_TRANSFER',
          description: message || `Sending transfers`
        }
      );
      job.on('finish', resolve);
      job.on('failed', err => {
        this.log(messageFail || 'Could not send transfer to the tangle', err);
        reject(err);
      });
    });
  }

  restoreAddresses(addresses, message, messageFail) {
    message = message || `Restoring addresses`;
    messageFail = messageFail || 'Could not restore the addresses';
    return Promise.all(
      addresses.map(
        async address =>
          await this.sendTransfers(
            [{ address, value: 0 }],
            null,
            message,
            messageFail
          )
      )
    ).then(res => {
      this.onChange();
      return res;
    });
  }

  async restoreMissingAddresses(total, message, messageFail) {
    const addresses = await this.getNewAddress(total);
    return await this.restoreAddresses(addresses, message, messageFail);
  }
}

module.exports = {
  DEFAULT_OPTIONS,
  BasePage
};
