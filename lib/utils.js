var Api = require('scaleway'),
    Datastore = require('nedb'),
    Q = require('q'),
    Table = require('cli-table'),
    _ = require('lodash'),
    async = require('async'),
    attempt = require('attempt'),
    child_process = require('child_process'),
    debug = require('debug')('scaleway-cli:utils'),
    filesizeParser = require('filesize-parser'),
    portScanner = require('portscanner'),
    util = require('util'),
    validator = require('validator');


var db = module.exports.db = new Datastore({
  filename: '/tmp/scw.db',
  autoload: false
});


module.exports.dbInit = function(fn) {
  attempt(
    { retries: 15 },
    function(attempts) {
      db.loadDatabase(this);
    },
    function (err, results) {
      assert(err);
      fn();
    }
  );
};


var prepareEntity = function(entity, category) {
    entity._id = entity.id;
    entity._type = category;
    entity.creation_date = entity.creation_date || new Date(1970, 1, 1);
    return entity;
};


if (RegExp.prototype.toJSON === undefined) {
  RegExp.prototype.toJSON = RegExp.prototype.toString;
}
var inspect = function(name, obj) {
  debug(name, '\n' + JSON.stringify(obj, null, 4));
};


module.exports.saveEntity = function(entity, category) {
  entity = prepareEntity(entity, category);
  db.insert([entity], function(err, newDocs) {
    assert(err);
  });
};


module.exports.saveEntities = function(entities, category) {
  entities = _.map(entities, function(entity) {
    return prepareEntity(entity, category);
  });

  db.remove(
    { _type: category },
    { multi: true },
    function(err, numRemoved) {
      debug('saveEntities: removed ' + numRemoved + ' items');
      assert(err);
      db.insert(entities, function(err, newDocs) {
        debug('saveEntities: inserted ' + newDocs.length + ' items');
        assert(err);
      });
    });
  return entities;
};


module.exports.executeQuery = function(query, cb) {
  db.find(query, function(err, rows) {
    cb(err, rows);
    return (err ? null : rows);
  });
};


module.exports.searchEntity = function(opts, cb) {
  if (!opts.input) {
    return cb(true, null);
  }

  opts.quiet = opts.quiet || false;
  opts.filters = opts.filters || {};

  if (opts._type !== undefined) {
    opts.filters._type = opts._type;
    delete opts._type;
  }

  inspect('searchEntity::input', opts);

  var queries = [
    _.assign({
      _id: new RegExp('^' + opts.input, 'i')
    }, _.clone(opts.filters || {}))
  ];

  var nameRegex = opts.input.replace(/[_-]/g, '.*');

  if (!opts.filters._type || opts.filters._type == 'servers') {
    queries.push(
      _.assign({
        name: new RegExp(nameRegex, 'i'),
        _type: 'servers'
      }, _.clone(opts.filters || {}))
    );
  }

  if (!opts.filters._type || opts.filters._type == 'images') {
    queries.push(
      _.assign({
        name: new RegExp(nameRegex, 'i'),
        _type: 'images'
      }, _.clone(opts.filters || {}))
    );
    if (opts.input.indexOf('user/') == 0) {
      queries.push(
        _.assign({
          name: new RegExp(nameRegex.replace(/^user\//, ''), 'i'),
          _type: 'images'
        }, _.clone(opts.filters || {}))
      );
    }
  }

  if (!opts.filters._type || opts.filters._type == 'bootscripts') {
    queries.push(
      _.assign({
        title: new RegExp(nameRegex, 'i'),
        _type: 'bootscripts'
      }, _.clone(opts.filters || {}))
    );
  }

  inspect('searchEntity::queries', queries);

  return async.concat(queries, module.exports.executeQuery, function(err, results) {
    if (err) {
      if (opts.quiet) { return cb(null, results); }
      return cb(err, results);
    }
    if (results.length === 1) {
      return cb(null, results[0]);
    } else if (results.length === 0) {
      if (validator.isUUID(opts.input)) {
        return cb(null, { _id: opts.input });
      } else {
        if (opts.quiet) { return cb(null, results); }
        return cb('No such id for ' + opts.input, null);
      }
    } else {
      var output = 'too many candidates for ' + opts.input + ' (' + results.length + ')';
      _.forEach(results, function(result) {
        output += '\n- ' + result._id + ' - ' + result.name;
      });
      if (opts.quiet) { return cb(null, results); }
      return cb(output, results);
    }
  });
};


module.exports.waitForServerState = function(client, serverId, targetState, cb) {
  var latestState = 'unknown';
  var latestServer = null;
  async.whilst(
    function(a) {
      return latestState !== targetState;
    },
    function(whilstCb) {
      client.get('/servers/' + serverId)
        .then(function(res) {
          latestServer = res.body.server;
          latestState = res.body.server.state;
          if (latestState === targetState) {
            whilstCb(null, res.body.server);
          } else {
            setTimeout(whilstCb, 3000);
          }
        })
        .catch(panic);
    },
    function(err, server) {
      assert(err);
      cb(null, latestServer);
    });
};


module.exports.waitPortOpen = function(ip, port, cb) {
  var isPortOpen = false;
  async.until(
    function () { return isPortOpen; },
    function (loopCb) {
      portScanner.checkPortStatus(port, ip, function(err, statusOfPort) {
        debug('portscanner', port, ip, err, statusOfPort);
        if (statusOfPort === 'open') {
          isPortOpen = true;
          cb(err);
        } else {
          setTimeout(function() { loopCb(null); }, 3000);
        }
      });
    }, assert);
};


module.exports.searchEntities = function(opts, cb) {
  var promises = _.map(opts.inputs, function(input) {
    return {
      input: input,
      filters: opts.filters,
      quiet: opts.any
    };
  });
  return async.map(promises, module.exports.searchEntity, cb);
};


var error = module.exports.error = function(msg) {
  if (msg && msg.options && msg.options.method && msg.options.url &&
      msg.statusCode && msg.error && msg.error.message) {
    debug('panic', msg);
    console.error('> ' + msg.options.method + ' ' + msg.options.url);
    console.error('< ' + msg.error.message + ' (' + msg.statusCode + ')');
    if (msg.error.fields) {
      _.forEach(msg.error.fields, function(value, key) {
        console.log(' - ' + key + ': ' + value.join('. '));
      });
    }
  } else {
    console.error(msg);
  }
};


var panic = module.exports.panic = function(msg) {
  error(msg);
  console.error('');
  console.error('   Hey ! this is probably a bug !');
  console.error('   Fresh beers will be waiting for you on our next meetup');
  console.error('                          if you report a new issue :) 🍻');
  console.error('');
  console.error('          https://github.com/scaleway/scaleway-cli/issues');
  console.error('');
  process.exit(-1);
};


var assert = module.exports.assert = function(check, err) {
  if (typeof(err) == 'undefined') {
    err = check;
  }
  if (check) {
    panic(err);
  }
};


module.exports.notImplementedAction = function() {
  console.error("scw: Not implemented");
};


module.exports.truncateRow = function(row, limits) {
  for (var idx in row) {
    if (limits[idx] !== -1) {
      row[idx] = row[idx].toString().substring(0, limits[idx]);
    }
  }
  return row;
};


module.exports.defaultConfigPath = function() {
  var home = process.env[(
    process.platform === 'win32' ?
      'USERPROFILE' :
      'HOME'
  )];
  return home + '/.scwrc';
};


module.exports.newTable = function(options) {
  options = options || {};
  options.chars = options.chars || {
    'top': '', 'top-mid': '', 'top-left': '', 'top-right': '',
    'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
    'left': '', 'left-mid': '', 'mid': '', 'mid-mid': '',
    'right': '', 'right-mid': '', 'middle': ' '
  };
  options.style = options.style || {
    // 'padding-left': 0, 'padding-right': 0
  };
  return new Table(options);
};


module.exports.wordify = function(str) {
  return str
    .replace(/[^a-zA-Z0-9-]/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_/, '')
    .replace(/_$/, '');
};


module.exports.newApi = function(options) {
  var overrides = {};

  options = options || {};
  options.parent = options.parent || {};
  if (options.parent.apiEndpoint) {
    overrides.api_endpoint = options.parent.apiEndpoint;
  }
  if (options.parent.dryRun) {
    overrides.dry_run = options.parent.dryRun;
  }
  var config = module.exports.rc(overrides);
  return new Api(config);
};


module.exports.collect = function(val, memo) {
  memo.push(val);
  return memo;
};


module.exports.rc = function() {
  return require('scaleway/node_modules/rc')('scw', {
    api_endpoint: 'https://api.scaleway.com/',
    organization: null,
    token: null
  });
};


module.exports.getVersion = function(module) {
  return require(module + '/package.json').version;
};


module.exports.anonymizeUUID = function(uuid) {
  return uuid.replace(/^(.{4})(.{4})-(.{4})-(.{4})-(.{4})-(.{8})(.{4})$/, '$1-xxxx-$4-xxxx-xxxxxxxx$7');
};


module.exports.escapeShell = function(command) {
  if (typeof(command) !== 'string') {
    command = command.join(' ');
  }
  return '\'' + command.replace(/\'/g, "'\\''") + '\'';
};


module.exports.sshExec = function(ip, command, options, fn) {
  options = options || {};

  var args = [];

  if (!debug.enabled) {
    args.push('-q');
  }

  args = args.concat.apply(args, ['-l', 'root', ip, '/bin/sh', '-e']);

  if (options.verbose) {
    args.push('-x');
  }

  args.push('-c');
  args.push(module.exports.escapeShell(command));

  debug('spawn: ssh ' + args.join(' '));
  var spawn = child_process.spawn(
    'ssh',
    args,
    { stdio: 'inherit' }
  );
  if (fn) {
    spawn.on('close', function(code) {
      return fn(code);
    });
  }
  return spawn;
};


module.exports.createServer = function(client, options) {
  return client.createServer(options)
    .then(function (res) {
      module.exports.saveEntity(res.body.server, 'servers');
      console.log(res.body.server.id);
    })
    .catch(panic);
};


module.exports.getImageOrNewVolume = function(client, image, fn) {
  var ret;
  // Resolve image
  module.exports.searchEntity({input: image, _type: 'images'}, function(err, imageEntity) {
    if (err) {
      // err only means the image is not found.
      // when creating a server, if the image is not found we try to
      // create an image instead.
      var size;
      try {
        size = filesizeParser(image, {base: 10});
      } catch (e) {
        size = 0;
      }
      assert(!size, err);
      return client.post('/volumes', {
        organization: client.config.organization,
        size: parseInt(size),
        name: image,
        volume_type: 'l_ssd'
      }).then(function(results) {
        ret = {
          'volume': results.body.volume.id
        };
        fn(ret);
        return ret;
      }).catch(panic);
    } else {
      ret = {
        'image': imageEntity._id
      };
      fn(ret);
      return ret;
    }
  });
};


module.exports.panicTimeout = function(delay, name) {
  if (!delay) {
    return null;
  }
  return setTimeout(function() {
    panic(name + '... failed: Operation timed out.');
  }, delay * 1000);
};


module.exports.serverExec = function(ip, command, commandArgs, options, fn) {
  var args = [];

  if (!debug.enabled) {
    args.push('-q');
  }

  if (options.sshTimeout) {
    args = args.concat.apply(args, [
      '-o', 'ConnectTimeout=' + options.sshTimeout
    ], commandArgs);
  }

  args = args.concat.apply(args, [
    '-l', 'root',
    ip, '-t', '--', command], commandArgs);

  if (options.secure) {
    debug('Using secure SSH connection');
  } else {
    args = [].concat.apply([
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'StrictHostKeyChecking=no'
    ], args);
  }

  debug('spawn: ssh ' + args.join(' '));
  var spawn = child_process.spawn(
    'ssh',
    args,
    { stdio: 'inherit' }
  );
  if (fn) {
    spawn.on('close', fn);
  }
};
