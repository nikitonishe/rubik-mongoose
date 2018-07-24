const Rubik = require('rubik-main');
const mongoose = require('mongoose');
mongoose.Promise = global.Promise;
const querystring = require('querystring');
const isFunction = require('lodash/isFunction');
const isString = require('lodash/isString');
const delay = require('./delay');

const DEFAULT_RECONNECT_INTERVAL = 1000;

/**
 * The MongoDB Storage kubik for the Rubik
 * @class Mongoose
 * @prop {Array<String>} volumes — directories with models
 * @prop {Object} models    — mongoose.models
 * @prop {Object} mongoose  — instance of mongoose
 * @prop {Mixed} connection — connection of mongoose, null before up
 * @prop {Mixed} db         — native MongoDB connection, null before up
 */
class Mongoose extends Rubik.Kubik {
  constructor(volumes) {
    super();
    this.volumes = [];
    this.models = mongoose.models;
    this.mongoose = mongoose;
    this.connection = null;

    if (Array.isArray(volumes)) {
      this.volumes = volumes;
    } else if (typeof volumes === 'string') {
      this.volumes.push(volumes);
    }
  }

  /**
   * Create connection string to MongoDB
   * @param  {Object} connConfig — configuration object (config.get('storage').connection)
   * @return {String}              mongodb connection string
   */
  getConnectionUri(connConfig) {
    if (!connConfig) connConfig = this.options.connection;
    let uri = 'mongodb://';
    if (connConfig.username) {
      uri = uri + connConfig.username;
      uri += connConfig.password ? `:${connConfig.password}` : '';
      uri += '';
    }

    if (Array.isArray(connConfig.members)) {
      const members = connConfig.members.join(',');
      uri += members;
    } else {
      uri += connConfig.host;
      if (connConfig.port) uri = uri + ':' + connConfig.port;
    }
    uri += '/' + connConfig.database;

    if (connConfig.options) {
      uri += `?${querystring.stringify(connConfig.options)}`;
      this.isReplicaSet = !!connConfig.options.replicaSet;
    }
    return uri;
  }

  /**
   * Up kubik
   * @param  {Object} dependencies of kubik
   * @return {Promise}
   */
  async up(dependencies) {
    Object.assign(this, dependencies);
    this.options = this.config.get(this.name);

    this.databaseName = (this.config.connection
      && this.config.connection.database)
      || 'test';
    if (this.db) return this.db;
    await this.applyHooks('before');

    for (const extension of this.extensions) {
      this.applyExtension(extension);
    }

    await this.readModels();
    await this.connect();
    return this.db;
  }

  /**
   * Apply kubik extensions
   * @param  {Mixed} extension
   */
  applyExtension(extension) {
    if (isString(extension)) return this.volumes.push(extension);
    if (Array.isArray(extension)) {
      return this.volumes = this.volumes.concat(extension);
    }
    return this.applyModel(extension);
  }

  /**
   * Read models from volumes
   * @return {Promise}
   */
  readModels() {
    const path = require('path');
    for (const volume of this.volumes) {
      return Rubik.helpers.readdir(volume, (file) => {
        const value = require(path.join(volume, file));
        if (isFunction(value)) {
          value(this, mongoose);
        } else if (value && value.name && value.schema) {
          this.applyModel(value);
        }
      });
    }
  }

  /**
   * Apply model to mongoose
   * @param  {Object} model hash
   * @param {String} model.name — name of model
   * @param {mongoose.Schema} model.schema — schema of model
   * @param {String} [model.collection] — additional name for MongoDB's collection
   */
  applyModel(model) {
    if (!(model && model.name && model.schema)) return;
    const collection = model.collection || undefined;
    mongoose.model(model.name, model.schema, collection);
  }

  /**
   * Connect mongoose to the MongoDB
   * @param  {Object} config config object
   * @return {Promise}       resolve => connection to MongoDB, reject => connection error
   */
  async connect() {
    const reg = /failed to connect to server \[.*?\] on first connect/;
    const config = this.config.get('storage');

    const connect = () => {
      return mongoose.connect(
        this.getConnectionUri(config.connection),
        config.options
      ).catch(async (err) => {
        if (reg.test(err.message)) {
          // If error is «failed to connect to server on first connect»
          // delay and try again
          await delay(config.options.reconnectInterval || DEFAULT_RECONNECT_INTERVAL);
          return connect();
        }
        throw err;
      });
    }

    await connect();

    this.log.info('Storage connected to mongodb 🍔');
    this.log.info('Database: ' + this.databaseName);

    if (this.isReplicaSet) {
      this.log.info(
        `Connected to Replica Set: ${config.connection.members
                                    ? config.connection.members.join(', ')
                                    : config.connection.host}`
      );
    }

    this.db = mongoose.connection.db;
    this.connection = mongoose.connection;
    return this.connection;
  }

  /**
   * Get native collection by name
   * @param  {String} name — name of collection
   * @return {MongoDB.Collection}
   */
  collection(name) {
    if (!this.db) throw new Error('You should connect before get collection');
    return this.db.collection(name);
  }


  async after() {
    await this.applyHooks('after');
  }
}

Mongoose.prototype.name = 'storage';
Mongoose.prototype.dependencies = Object.freeze(['config', 'log']);

module.exports = Mongoose;