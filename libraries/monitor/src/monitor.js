const debug = require('debug')('taskcluster-lib-monitor');
const _ = require('lodash');
const Promise = require('bluebird');
const raven = require('raven');
const BaseMonitor = require('./base');

class Monitor extends BaseMonitor {

  constructor(sentryDSN, sentry, statsumClient, auditlog, opts) {
    super();
    this._opts = opts;
    this._sentryDSN = sentryDSN;
    // This must be a Promise that resolves to {client, expires}
    this._sentry = sentry || Promise.resolve({client: null, expires: new Date(0)});
    this._statsum = statsumClient;
    this._auditlog = auditlog;
    this._resourceInterval = null;
  }

  async reportError(err, level='error', tags={}) {
    if (!_.isString(level)) {
      tags = level;
      level = 'error';
    }

    if (!this._opts.enable) {
      console.log('reportError - level: %s, tags: %j\n', level, tags, err);
      return;
    }

    this._sentry = this._sentry.then(async (sentry) => {
      if (!sentry.expires || Date.parse(sentry.expires) <= Date.now()) {
        const sentryInfo = await this._sentryDSN(this._opts.projectName);
        return {
          client: new raven.Client(sentryInfo.dsn.secret, _.defaults(
            {}, this._opts.sentryOptions, {
              release: this._opts.gitVersion,
            })),
          expires: sentryInfo.expires,
        };
      }
      return sentry;
    }).catch(e => {
      console.log('While trying to report %s\n...getting sentry DSN failed: %s',
        err.stack || err, e.stack);
      return {client: null, expires: new Date(0)};
    });

    return this._sentry.then(sentry => {
      if (!sentry.client) {
        // error was already reported
        return Promise.resolve(false);
      }

      sentry.client.captureException(err, {
        tags: _.defaults({
          prefix: this._opts.projectName + (this._opts.prefix || '.root'),
          process: this._procName || 'unknown',
        }, tags),
        level,
      });

      return new Promise((accept, reject) => {
        let onLogged, onError;
        onLogged = () => {
          sentry.client.removeListener('error', onError);
          accept(true);
        };
        onError = (e) => {
          sentry.client.removeListener('logged', onLogged);
          console.log('While trying to report %s\n...reporting to sentry failed: %s',
            err.stack, e.stack);
          accept(false);
        };
        sentry.client.once('logged', onLogged);
        sentry.client.once('error', onError);
      });
    });
  }

  log(record) {
    this._auditlog.log(record);
  }

  count(key, val) {
    if (this._statsum) {
      this._statsum.count(key, val || 1);
    }
  }

  measure(key, val) {
    if (this._statsum) {
      this._statsum.measure(key, val);
    }
  }

  async flush() {
    await Promise.all([
      this._statsum && this._statsum.flush(),
      this._auditlog.flush(),
    ]);
  }

  prefix(prefix) {
    const newopts = _.cloneDeep(this._opts);
    newopts.prefix = (this._opts.prefix || '') + '.' + prefix;
    return new Monitor(
      this._sentryDSN,
      this._sentry,
      this._statsum && this._statsum.prefix(prefix),
      this._auditlog,
      newopts
    );
  }
}

module.exports = Monitor;
