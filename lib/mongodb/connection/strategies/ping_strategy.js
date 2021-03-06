var Server = require("../server").Server;

// The ping strategy uses pings each server and records the
// elapsed time for the server so it can pick a server based on lowest
// return time for the db command {ping:true}
var PingStrategy = exports.PingStrategy = function(replicaset, secondaryAcceptableLatencyMS) {
  this.replicaset = replicaset;
  this.secondaryAcceptableLatencyMS = secondaryAcceptableLatencyMS;
  this.state = 'disconnected';
  this.pingInterval = 5000;
  // Class instance
  this.Db = require("../../db").Db;
}

// Starts any needed code
PingStrategy.prototype.start = function(callback) {
  // already running?
  if ('connected' == this.state) return;

  this.state = 'connected';

  // Start ping server
  this._pingServer(callback);
}

// Stops and kills any processes running
PingStrategy.prototype.stop = function(callback) {
  // Stop the ping process
  this.state = 'disconnected';

  // optional callback
  callback && callback(null, null);
}

PingStrategy.prototype.checkoutSecondary = function(tags, secondaryCandidates) {
  // Servers are picked based on the lowest ping time and then servers that lower than that + secondaryAcceptableLatencyMS
  // Create a list of candidat servers, containing the primary if available
  var candidateServers = [];

  // If we have not provided a list of candidate servers use the default setup
  if(!Array.isArray(secondaryCandidates)) {
    candidateServers = this.replicaset._state.master != null ? [this.replicaset._state.master] : [];
    // Add all the secondaries
    var keys = Object.keys(this.replicaset._state.secondaries);
    for(var i = 0; i < keys.length; i++) {
      candidateServers.push(this.replicaset._state.secondaries[keys[i]])
    }
  } else {
    candidateServers = secondaryCandidates;
  }

  // Final list of eligable server
  var finalCandidates = [];

  // If we have tags filter by tags
  if(tags != null && typeof tags == 'object') {
    // If we have an array or single tag selection
    var tagObjects = Array.isArray(tags) ? tags : [tags];
    // Iterate over all tags until we find a candidate server
    for(var _i = 0; _i < tagObjects.length; _i++) {
      // Grab a tag object
      var tagObject = tagObjects[_i];
      // Matching keys
      var matchingKeys = Object.keys(tagObject);
      // Remove any that are not tagged correctly
      for(var i = 0; i < candidateServers.length; i++) {
        var server = candidateServers[i];
        // If we have tags match
        if(server.tags != null) {
          var matching = true;

          // Ensure we have all the values
          for(var j = 0; j < matchingKeys.length; j++) {
            if(server.tags[matchingKeys[j]] != tagObject[matchingKeys[j]]) {
              matching = false;
              break;
            }
          }

          // If we have a match add it to the list of matching servers
          if(matching) {
            finalCandidates.push(server);
          }
        }
      }
    }
  } else {
    // Final array candidates
    var finalCandidates = candidateServers;
  }

  // Sort by ping time
  finalCandidates.sort(function(a, b) {
    return a.runtimeStats['pingMs'] > b.runtimeStats['pingMs'];
  });

  if(0 === finalCandidates.length)
    return new Error("No replica set members available for query");

  // handle undefined pingMs
  var lowestPing = finalCandidates[0].runtimeStats['pingMs'] | 0;

  // determine acceptable latency
  var acceptable = lowestPing + this.secondaryAcceptableLatencyMS;

  // remove any server responding slower than acceptable
  var len = finalCandidates.length;
  while(len--) {
    if(finalCandidates[len].runtimeStats['pingMs'] > acceptable) {
      finalCandidates.splice(len, 1);
    }
  }

  // If no candidates available return an error
  if(finalCandidates.length == 0)
    return new Error("No replica set members available for query");

  // Pick a random acceptable server
  return finalCandidates[Math.round(Math.random(1000000) * (finalCandidates.length - 1))].checkoutReader();
}

PingStrategy.prototype._pingServer = function(callback) {
  var self = this;

  // Ping server function
  var pingFunction = function() {
    if(self.state == 'disconnected') return;
    var addresses = self.replicaset._state.addresses;

    // Grab all servers
    var serverKeys = Object.keys(addresses);

    // Number of server entries
    var numberOfEntries = serverKeys.length;

    // We got keys
    for(var i = 0; i < serverKeys.length; i++) {

      // We got a server instance
      var server = addresses[serverKeys[i]];

      // Create a new server object, avoid using internal connections as they might
      // be in an illegal state
      new function(serverInstance) {
        var options = { poolSize: 1, timeout: 500, auto_reconnect: false };
        var server = new Server(serverInstance.host, serverInstance.port, options);
        var db = new self.Db(self.replicaset.db.databaseName, server);

        db.on("error", done);

        // Open the db instance
        db.open(function(err, _db) {
          if(err) return done(_db);

          // Startup time of the command
          var startTime = Date.now();

          // Execute ping on this connection
          db.executeDbCommand({ping:1}, {failFast:true}, function() {
            if(null != serverInstance.runtimeStats && serverInstance.isConnected()) {
              serverInstance.runtimeStats['pingMs'] = Date.now() - startTime;
            }

            done(_db);
          })
        })

        function done (_db) {
          // Close connection
          _db.close(true);

          // Adjust the number of checks
          numberOfEntries--;

          // If we are done with all results coming back trigger ping again
          if(0 === numberOfEntries && 'connected' == self.state) {
            setTimeout(pingFunction, self.pingInterval);
          }
        }
      }(server);
    }
  }

  // Start pingFunction
  setTimeout(pingFunction, 1000);

  callback && callback(null);
}
