/*
 * dos2unix
 * https://github.com/JamesMGreene/node-dos2unix
 *
 * Copyright (c) 2013 James M. Greene
 * Licensed under the MIT license.
 */

'use strict';

// Built-in modules
var fs = require('fs');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

// External modules
var Q = require('q');
var BinaryReader = require('buffered-reader').BinaryReader;

// Internal modules
var encoder = require('./util/encoding');
var globber = require('./util/glob');
var validator = require('./util/validate');


function determineProcessingStatusOfFile(filePath, done) {
  encoder.detectBom(filePath, function(err, bom) {
    var status = 'good';
    var needsFixing = false;
    var lastByteSequenceWasCR = false;
    var bytesPerBom = encoder.getBytesPerBom(bom);
    var bytesPerControlChar = encoder.getBytesPerControlChar(bom);

    var reader = new BinaryReader(filePath);

    var readCallback = function(err, buffer, bytesRead) {
      if (err) {
        status = 'error';
        console.error('Error while processing "' + filePath + '": ' + (err.stack || err));
        return done(null, status);
      }
      else if (bytesRead === bytesPerControlChar) {
        if (encoder.doesByteSequenceSuggestBinary(buffer, bom)) {
          status = 'binary';
          return done(null, status);
        }
        else if (encoder.isByteSequenceCR(buffer, bom)) {
          lastByteSequenceWasCR = true;
        }
        else {
          if (lastByteSequenceWasCR && encoder.isByteSequenceLF(buffer, bom)) {
            needsFixing = true;
          }
          lastByteSequenceWasCR = false;
        }
        // else continue
        
        // Check for EOF
        if (reader.isOffsetOutOfWindow()) {
          if (status === 'good' && needsFixing) {
            status = 'bad';
          }
          // Close the file
          reader.close(function(errClosing) {
            if (errClosing) {
              console.error('Error while closing "' + filePath + '": ' + (errClosing.stack || errClosing));
            }
            return done(null, status);
          });
        }
        else {
          process.nextTick(function() {
            reader.read(bytesPerControlChar, readCallback);
          });
        }
      }
      else if (bytesRead > 0) {
        status = 'error';
        console.error('Error while processing "' + filePath + '": did not read expected number of bytes');
        return done(null, status);
      }
    };
    
    // Fast-forward past the BOM if present
    if (bytesPerBom > 0) {
      reader.read(bytesPerBom, function(err, buffer, bytesRead) {
        if (err) {
          console.error('Error while processing "' + filePath + '": ' + (err.stack || err));
          status = 'error';
          return done(null, status);
        }
        else if (bytesRead < bytesPerBom) {
          console.error('Error while processing "' + filePath + '": Unable to read past the expected BOM');
          status = 'error';
          return done(null, status);
        }
        reader.read(bytesPerControlChar, readCallback);
      });
    }
    else {
      reader.read(bytesPerControlChar, readCallback);
    }
  });
}

function convertFileFromDosToUnix(filePath, done) {
  fs.readFile(filePath, function(err, buffer) {
    if (err) {
      console.error('Error while reading file "' + filePath + '": ' + (err.stack || err));
    }
    else {
      var outFile = fs.createWriteStream(filePath);
      outFile.on('error', function(err) {
        console.error('Error while writing file "' + filePath + '": ' + (err.stack || err));
        return done(null);
      });
      outFile.on('close', function() {
        return done(null);
      });
      
      var bom = encoder.detectBomFromBuffer(buffer.slice(0, 4));
      var bytesPerBom = encoder.getBytesPerBom(bom);
      var bytesPerControlChar = encoder.getBytesPerControlChar(bom);
      var lastByteSequenceWasCR = false;
      var lastWriteIndex = 0;
      var byteSequence;
      
      for (var b = bytesPerBom, len = buffer.length; b < len; b += bytesPerControlChar) {
        byteSequence = buffer.slice(b, b + bytesPerControlChar);
        if (encoder.isByteSequenceCR(byteSequence)) {
          lastByteSequenceWasCR = true;
        }
        else {
          if (lastByteSequenceWasCR && encoder.isByteSequenceLF(byteSequence, bom)) {
            // Write everything read since the last write up to the CR (but omit the CR)
            outFile.write(buffer.slice(lastWriteIndex, b - bytesPerControlChar));

            // The next write will start with including this LF
            lastWriteIndex = b;
          }
          // Else if at end of buffer, finalize the file rewrite
          else if ((b + bytesPerControlChar) === len) {
            outFile.end(buffer.slice(lastWriteIndex, b + bytesPerControlChar));
            outFile.destroySoon();
            console.log('Successfully rewrote file: ' + filePath);
          }
          lastByteSequenceWasCR = false;
        }
      }
    }
  });
}


// Promise bindings
var globP = Q.nfbind(globber.glob);
var determineProcessingStatusOfFileP = Q.nfbind(determineProcessingStatusOfFile);
var convertFileFromDosToUnixP = Q.nfbind(convertFileFromDosToUnix);

// Important method!
function dos2unix(globPatterns, options, done) {
  // Validate input
  if (typeof options === 'function' && done == null) {
    done = options;
    options = null;
  }
  done = validator.validateDone(done);
  options = validator.validateOptions(options, done);
  var validGlobPatterns = validator.validateGlobPatterns(globPatterns, done);

  // GO!
  // Find the pertinent files from the glob, sorted and without duplicates
  globP(validGlobPatterns, options.glob)
  .then(function(fileList) {
    // Figure out which files are binary
    return Q.all(
      fileList.map(function(filePath) {
        return determineProcessingStatusOfFileP(filePath);
      })
    )
    .then(function(safetyList) {
      return fileList.map(function(filePath, i) {
        return { path: filePath, status: safetyList[i] };
      });
    });
  })
  .then(function(fileListWithSafetyInfo) {
    // Filter out any files that cannot or should not be "fixed"
    return fileListWithSafetyInfo.filter(function(fileInfo) {
      if (fileInfo.status === 'error') {
        console.error('Skipping file with errors during read: ' + fileInfo.path);
      }
      else if (fileInfo.status === 'binary') {
        console.log('Skipping suspected binary file: ' + fileInfo.path);
      }
      else if (fileInfo.status === 'good') {
        console.log('Skipping file that does not need fixing: ' + fileInfo.path);
      }
      else {
        console.log('File needs fixing: ' + fileInfo.path);
      }
      return fileInfo.status === 'bad';
    })
    .map(function(needsFixingFileInfo) {
      return needsFixingFileInfo.path;
    });
  })
  .then(function(needsFixingFileList) {
    // Process the safe files
    var messageStart = 'Converting line endings from "\\r\\n" to "\\n" in file: ';
    return Q.all(
      needsFixingFileList.map(function(filePath) {
        console.log(messageStart + filePath);
        return convertFileFromDosToUnixP(filePath);
      })
    );
  })
  .then(function() {
    done();
  })
  .fail(done)
  .done();
}

function Dos2UnixConverter(globPatterns, options) {
  // Enforce the constructor pattern
  if (!(this instanceof Dos2UnixConverter)) {
    return new Dos2UnixConverter(globPatterns, options);
  }

  // Mixin the EventEmitter API
  EventEmitter.call(this);

  // Save the arguments
  this.globPatterns = globPatterns;
  this.options = options;
}
// Mark it as inherited, too
util.inherits(Dos2UnixConverter, EventEmitter);

// GO!
Dos2UnixConverter.prototype.process = function() {
  // Find the pertinent files from the glob, sorted and without duplicates
  globP(this.globPatterns, this.options.glob)
  .then(function(fileList) {
    // Figure out which files are binary
    return Q.all(
      fileList.map(function(filePath) {
        return determineProcessingStatusOfFileP(filePath);
      })
    )
    .then(function(safetyList) {
      return fileList.map(function(filePath, i) {
        return { path: filePath, status: safetyList[i] };
      });
    });
  })
  .then(function(fileListWithSafetyInfo) {
    // Filter out any files that cannot or should not be "fixed"
    return fileListWithSafetyInfo.filter(function(fileInfo) {
      if (fileInfo.status === 'error') {
        this.emit('convert.error', {
          file: fileInfo.path,
          status: fileInfo.status,
          message: 'Skipping file with errors during read'
        });
      }
      else if (fileInfo.status === 'binary') {
        this.emit('convert.skip', {
          file: fileInfo.path,
          status: fileInfo.status,
          message: 'Skipping suspected binary file'
        });
      }
      else if (fileInfo.status === 'good') {
        this.emit('convert.skip', {
          file: fileInfo.path,
          status: fileInfo.status,
          message: 'Skipping file that does not need fixing'
        });
      }
      else {
        this.emit('convert.start', {
          file: fileInfo.path,
          status: fileInfo.status,
          message: 'File needs fixing'
        });
      }
      // Filter down to just those files that need fixing
      return fileInfo.status === 'bad';
    })
    .map(function(needsFixingFileInfo) {
      return needsFixingFileInfo.path;
    });
  })
  .then(function(needsFixingFileList) {
    // Process the safe files
    var messageStart = 'Converting line endings from "\\r\\n" to "\\n" in file: ';
    return Q.all(
      needsFixingFileList.map(function(filePath) {
        console.log(messageStart + filePath);
        return convertFileFromDosToUnixP(filePath);
      })
    );
  })
  .then(function() {
    done();
  })
  .fail(done)
  .done();
};

Dos2UnixConverter.prototype.processFile = function(filePath) {
  encoder.detectBom(filePath, function(err, bom) {
    var status = 'good';
    var needsFixing = false;
    var lastByteSequenceWasCR = false;
    var bytesPerBom = encoder.getBytesPerBom(bom);
    var bytesPerControlChar = encoder.getBytesPerControlChar(bom);

    // TODO: Replace `BinaryReader` use with something from Node.js core
    //var reader = new BinaryReader(filePath);
  });
};

function createD2UEventEmitter(globPatterns, options, done) {
  // Validate input
  if (typeof options === 'function' && done == null) {
    done = options;
    options = null;
  }
  var hasOwnDoneFn = typeof done === 'function';
  var validDone = validator.validateDone(done, true);
  var validOptions = validator.validateOptions(options, validDone);
  var validGlobPatterns = validator.validateGlobPatterns(globPatterns, validDone);

  var d2u = new Dos2UnixConverter(validGlobPatterns, validOptions);
  if (hasOwnDoneFn && typeof validDone === 'function') {
    d2u.on('error', function(err) {
      validDone(err);
    });
    d2u.on('end', function(results) {
      validDone(null, results);
    });
    
    // Auto-start the processing
    d2u.process();
  }
  return d2u;
}

// Exports
module.exports = createD2UEventEmitter;