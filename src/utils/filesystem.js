/* eslint-disable global-require */
/* global FileWriter, FileError, cordova */
const uuid = require('uuid/v4');
const { Writable } = require('stream');
const { trimChars } = require('lodash/fp');
const { Buffer } = require('buffer/');
const environments = require('./environments');
const { ExportError, ErrorMessages } = require('../errors/ExportError');
const { inEnvironment, isElectron, isCordova } = require('./Environment');

const trimPath = trimChars('/ ');

const resolveOrRejectWith = (resolve, reject) => (err, ...args) => {
  if (err) {
    reject(err);
  } else {
    resolve(...args);
  }
};

const splitUrl = (targetPath) => {
  const pathParts = trimPath(targetPath).split('/');
  const baseDirectory = `${pathParts.slice(0, -1).join('/')}/`;
  const directory = `${pathParts.slice(-1)}`;
  return [baseDirectory, directory];
};

const inSequence = (items, apply) =>
  items.reduce(
    (result, item) => result.then(() => apply(item)),
    Promise.resolve(),
  );

const tempDataPath = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    let electron;

    if (typeof window !== 'undefined' && window) {
      electron = window.require('electron');
    } else {
      // if no window object assume we are in nodejs environment (Electron main)
      electron = require('electron');
    }

    return () => (electron.app || electron.remote.app).getPath('temp');
  }

  if (environment === environments.CORDOVA) {
    return () => cordova.file.cacheDirectory;
  }

  throw new Error(`userDataPath() not available on platform ${environment}`);
});

const resolveFileSystemUrl = inEnvironment((environment) => {
  if (environment === environments.CORDOVA) {
    return path => new Promise((resolve, reject) =>
      window.resolveLocalFileSystemURL(path, resolve, reject));
  }

  throw new Error(`resolveFileSystemUrl() not available on platform ${environment}`);
});

const createDirectory = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    const fse = require('fs-extra');

    return targetPath =>
      fse.mkdir(targetPath)
        .then(() => targetPath)
        .catch((error) => {
          if (error.code !== 'EEXISTS') { return Promise.reject(error); }
          throw error;
        });
  }

  if (environment === environments.CORDOVA) {
    const appendDirectory = (directoryEntry, directoryToAppend) =>
      new Promise((resolve, reject) => {
        directoryEntry.getDirectory(
          directoryToAppend,
          { create: true },
          resolve,
          reject,
        );
      });

    return (targetUrl) => {
      const [baseDirectory, directoryToAppend] = splitUrl(targetUrl);

      return resolveFileSystemUrl(baseDirectory)
        .then(directoryEntry => appendDirectory(directoryEntry, directoryToAppend));
    };
  }

  throw new Error(`createDirectory() not available on platform ${environment}`);
});

/**
 * Create a new temp directory to hold intermediate export files
 * @async
 * @return {string} the directory (path) created
 */

const makeTempDir = () => {
  const directoryName = `temp-export-${uuid()}`;
  let directoryPath;
  if (isElectron()) {
    const path = require('path');
    directoryPath = path.join(tempDataPath(), directoryName);
  }

  if (isCordova()) {
    directoryPath = `${tempDataPath()}${directoryName}`;
  }

  if (!directoryPath) {
    return Promise.reject(new ExportError(ErrorMessages.NoTmpFS));
  }

  return createDirectory(directoryPath);
};

const userDataPath = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    let electron;

    if (typeof window !== 'undefined' && window) {
      electron = window.require('electron');
    } else {
      // if no window object assume we are in nodejs environment (Electron main)
      electron = require('electron');
    }

    return () => (electron.app || electron.remote.app).getPath('userData');
  }

  if (environment === environments.CORDOVA) {
    return () => 'cdvfile://localhost/persistent';
  }

  throw new Error(`userDataPath() not available on platform ${environment}`);
});

const getFileNativePath = inEnvironment((environment) => {
  if (environment === environments.CORDOVA) {
    return filePath => new Promise((resolve, reject) => {
      window.resolveLocalFileSystemURL(filePath, (fileEntry) => {
        resolve(fileEntry.toURL());
      }, error => reject(error));
    });
  }

  throw new Error(`getFileNativePath() not available on platform ${environment}`);
});

const appPath = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    const electron = require('electron');

    return () => (electron.app || electron.remote.app).getAppPath();
  }

  if (environment === environments.CORDOVA) {
    return () => cordova.file.applicationDirectory;
  }

  throw new Error(`appDataPath() not available on platform ${environment}`);
});

const getFileEntry = (filename, fileSystem) => new Promise((resolve, reject) => {
  fileSystem.root.getFile(filename, { create: true, exclusive: false },
    fileEntry => resolve(fileEntry),
    err => reject(err));
});


const getTempFileSystem = () => new Promise((resolve, reject) => {
  window.resolveLocalFileSystemURL(cordova.file.cacheDirectory, (dirEntry) => {
    resolve(dirEntry);
  }, error => reject(error));
});

const readFile = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    const fse = require('fs-extra');

    return filename =>
      fse.readFile(filename, null);
  }

  if (environment === environments.CORDOVA) {
    const fileReader = fileEntry =>
      new Promise((resolve, reject) => {
        fileEntry.file((file) => {
          const reader = new FileReader();

          reader.onloadend = (event) => {
            resolve(Buffer.from(event.target.result));
          };

          reader.onerror = error => reject(error);

          reader.readAsArrayBuffer(file);
        }, reject);
      });

    return filename =>
      resolveFileSystemUrl(filename)
        .then(fileReader);
  }

  throw new Error(`readFile() not available on platform ${environment}`);
});

const makeFileWriter = fileEntry =>
  new Promise((resolve, reject) => {
    fileEntry.createWriter(resolve, reject);
  });

const createReader = fileEntry => new Promise((resolve, reject) => {
  fileEntry.file(
    file => resolve(file),
    err => reject(err),
  );
});

const newFile = (directoryEntry, filename) =>
  new Promise((resolve, reject) => {
    directoryEntry.getFile(filename, { create: true }, resolve, reject);
  });

const concatTypedArrays = (a, b) => {
  const combined = new Uint8Array(a.byteLength + b.byteLength);
  combined.set(a);
  combined.set(b, a.length);
  return combined;
};

const writeFile = inEnvironment((environment) => {
  if (environment === environments.CORDOVA) {
    return (fileUrl, data) => {
      const [baseDirectory, filename] = splitUrl(fileUrl);

      return resolveFileSystemUrl(baseDirectory)
        .then(directoryEntry => newFile(directoryEntry, filename))
        .then(makeFileWriter)
        .then(fileWriter =>
          new Promise((resolve, reject) => {
            fileWriter.onwriteend = () => resolve(fileUrl); // eslint-disable-line no-param-reassign
            fileWriter.onerror = error => reject(error); // eslint-disable-line no-param-reassign
            fileWriter.write(data);
          }));
    };
  }

  if (environment === environments.ELECTRON) {
    const fse = require('fs-extra');

    return (filePath, data) =>
      fse.writeFile(filePath, data);
  }

  throw new Error(`writeFile() not available on platform ${environment}`);
});

const rename = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    const fse = require('fs-extra');

    return (oldPath, newPath) =>
      fse.rename(oldPath, newPath);
  }

  if (environment === environments.CORDOVA) {
    return (oldPath, newPath) =>
      new Promise(async (resolve, reject) => {
        const [parent, name] = splitUrl(newPath);
        const toDirectory = await resolveFileSystemUrl(parent);
        const fromDirectory = await resolveFileSystemUrl(oldPath);
        return fromDirectory.moveTo(toDirectory, name, resolve, reject);
      });
  }

  throw new Error(`rename() not available on platform ${environment}`);
});

const removeDirectory = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    const fse = require('fs-extra');

    return targetPath =>
      new Promise((resolve, reject) => {
        try {
          if (
            !targetPath.includes(userDataPath())
            && !targetPath.includes(tempDataPath())
          ) { reject(new Error('Attempted to remove path outside of safe directories!')); return; }
          fse.rmdir(targetPath, { recursive: true }, resolve);
        } catch (error) {
          if (error.code !== 'EEXISTS') { reject(error); }
          throw error;
        }
      });
  }

  if (environment === environments.CORDOVA) {
    const removeRecursively = directoryEntry =>
      new Promise((resolve, reject) => {
        directoryEntry.removeRecursively(resolve, reject);
      });

    // If folder doesn't exist that's fine
    const ignoreMissingEntry = e => (
      e.code === FileError.NOT_FOUND_ERR
        ? Promise.resolve()
        : Promise.reject(e)
    );

    return targetUrl =>
      resolveFileSystemUrl(targetUrl)
        .then(removeRecursively)
        .catch(ignoreMissingEntry);
  }

  throw new Error(`removeDirectory() not available on platform ${environment}`);
});

const getNestedPaths = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    const path = require('path');

    return targetPath =>
      targetPath
        .split(path.sep)
        .reduce(
          (memo, dir) => (
            memo.length === 0
              ? [dir]
              : [...memo, path.join(memo[memo.length - 1], dir)]
          ),
          [],
        );
  }

  if (environment === environments.CORDOVA) {
    // Only tested for cdvfile:// format paths
    return (targetUrl) => {
      const pathMatcher = /^([a-z]+:\/\/[a-z]+\/[a-z]+\/)(.*)/;
      const matches = pathMatcher.exec(targetUrl);

      const location = matches[1];
      const path = trimPath(matches[2]).split('/');

      return path
        .reduce(
          (memo, dir) => (
            memo.length === 0
              ? [dir]
              : [...memo, `${memo[memo.length - 1]}${dir}/`]
          ),
          [location],
        )
        .slice(1);
    };
  }

  throw new Error(`getNestedPaths() not available on platform ${environment}`);
});

const writeStream = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    const fse = require('fs-extra');

    return (destination, stream) =>
      new Promise((resolve, reject) => {
        try {
          stream
            .pipe(fse.createWriteStream(destination))
            .on('error', reject)
            .on('finish', () => {
              resolve(destination);
            });
        } catch (error) {
          reject(error);
        }
      });
  }

  if (environment === environments.CORDOVA) {
    /**
     * Provides a pseudo-streaming mechanism for writing files.
     * Passes each chunk to a fileWriter, and on writeend, continues with the next chunk.
     * The file can be written to as long as its readyState is not WRITING.
     *
     * The goal here is to reduce the memory footprint on mobile as much as possible, but we
     * have to buffer each chunk sent temporarily, since the native stream may not write all bytes.
     * Still, we provide as much backpressure to JSZip's stream as possible (with `pause`).
     *
     * @param  {string} destUrl filePath to write to
     * @param  {StreamHelper} stream A JSZip "internal" stream of type "arraybuffer" or "uint8array"
     *                               (see [JSZip docs]{@link https://stuk.github.io/jszip/documentation/api_zipobject/internal_stream.html})
     * @private
     */
    return (destUrl, stream) => {
      const [baseDirectory, filename] = splitUrl(destUrl);
      return new Promise((resolve, reject) => {
        resolveFileSystemUrl(baseDirectory)
          .then(directoryEntry => newFile(directoryEntry, filename))
          .then(makeFileWriter)
          .then((fileWriter) => {
            let bufferedChunkBytes = new Uint8Array();
            // Needed to calculate bytesWritten since not provided by Cordova
            let previousFileWriterLength = 0;
            // We won't know how many bytes we need to write until we're done
            // This flag lets writeend handler know not to expect any more
            let reachedEndOfInputStream = false;

            const handleError = (err) => {
              console.error(err); // eslint-disable-line no-console
              if (stream) {
                stream.pause();
              }
              if (fileWriter && fileWriter.readyState === FileWriter.WRITING) {
                fileWriter.abort();
              }
              reject(err);
            };

            const writeChunk = (chunkByteArray) => {
              previousFileWriterLength = fileWriter.length;
              const { byteLength } = chunkByteArray;
              const data = chunkByteArray.slice(0, byteLength);
              try {
                // fileWriter.write documents a blob arg, but called with a blob,
                // it will read the blob to an arraybuffer and then re-call itself.
                fileWriter.write(data.buffer);
              } catch (err) {
                handleError(err);
              }
            };

            const onChunkWritten = () => {
              const bytesWritten = fileWriter.length - previousFileWriterLength;
              bufferedChunkBytes = bufferedChunkBytes.slice(bytesWritten);
              if (fileWriter.error) {
                // already handled by onerror; ignore here
              } else if (bufferedChunkBytes.length) {
                writeChunk(bufferedChunkBytes);
              } else if (reachedEndOfInputStream) {
                resolve(destUrl);
              } else {
                stream.resume();
              }
            };

            const onChunkReceived = (chunkByteArray) => {
              stream.pause();
              bufferedChunkBytes = concatTypedArrays(bufferedChunkBytes, chunkByteArray);
              // Despite pausing, we may receive additional chunks before previous has completed,
              // in which case we wait until the current write ends.
              if (fileWriter.readyState !== FileWriter.WRITING) {
                writeChunk(chunkByteArray);
              }
            };

            fileWriter.onwriteend = onChunkWritten; // eslint-disable-line no-param-reassign
            fileWriter.onerror = handleError; // eslint-disable-line no-param-reassign

            stream
              .on('error', handleError)
              .on('data', onChunkReceived)
              .on('end', () => {
                if (bufferedChunkBytes.length === 0) {
                  resolve(destUrl);
                } else {
                  reachedEndOfInputStream = true;
                }
              })
              .resume();
          });
      });
    };
  }

  throw new Error(`writeStream() not available on platform ${environment}`);
});

// Objective here is to abstract fs.createWriteStream.
// Needs to return a writeable stream.
const createWriteStream = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    const fse = require('fs-extra');

    return destination =>
      new Promise((resolve, reject) => {
        try {
          const ws = fse.createWriteStream(destination);
          resolve(ws);
        } catch (error) {
          reject(error);
        }
      });
  }

  if (environment === environments.CORDOVA) {
    /**
     * Provides a pseudo-streaming mechanism for writing files.
     * Passes each chunk to a fileWriter, and on writeend, continues with the next chunk.
     * The file can be written to as long as its readyState is not WRITING.
     *
     * The goal here is to reduce the memory footprint on mobile as much as possible, but we
     * have to buffer each chunk sent temporarily, since the native stream may not write all bytes.
     * Still, we provide as much backpressure to JSZip's stream as possible (with `pause`).
     *
     * @param  {string} destUrl filePath to write to
     * @param  {StreamHelper} stream A JSZip "internal" stream of type "arraybuffer" or "uint8array"
     *                               (see [JSZip docs]{@link https://stuk.github.io/jszip/documentation/api_zipobject/internal_stream.html})
     * @private
     */
    return (destUrl) => {
      const [baseDirectory, filename] = splitUrl(destUrl);
      return new Promise((resolve, reject) => {
        resolveFileSystemUrl(baseDirectory)
          .then(directoryEntry => newFile(directoryEntry, filename))
          .then(makeFileWriter)
          .then((fileWriter) => {
            let bufferedChunkBytes = new Uint8Array();
            // Needed to calculate bytesWritten since not provided by Cordova
            let previousFileWriterLength = 0;
            // We won't know how many bytes we need to write until we're done
            // This flag lets writeend handler know not to expect any more
            // let reachedEndOfInputStream = false;

            const handleError = (err) => {
              console.error(err); // eslint-disable-line no-console
              // if (stream) {
              //   stream.pause();
              // }
              if (fileWriter && fileWriter.readyState === FileWriter.WRITING) {
                fileWriter.abort();
              }
              reject(err);
            };

            const writeChunk = (chunkByteArray) => {
              previousFileWriterLength = fileWriter.length;
              const { byteLength } = chunkByteArray;
              const data = chunkByteArray.slice(0, byteLength);
              try {
                // fileWriter.write documents a blob arg, but called with a blob,
                // it will read the blob to an arraybuffer and then re-call itself.
                fileWriter.write(data.buffer);
              } catch (err) {
                handleError(err);
              }
            };

            const onChunkWritten = () => {
              const bytesWritten = fileWriter.length - previousFileWriterLength;
              bufferedChunkBytes = bufferedChunkBytes.slice(bytesWritten);
              if (fileWriter.error) {
                // already handled by onerror; ignore here
              } else if (bufferedChunkBytes.length) {
                writeChunk(bufferedChunkBytes);
              }
            };

            const onChunkReceived = (chunkByteArray) => {
              bufferedChunkBytes = concatTypedArrays(bufferedChunkBytes, chunkByteArray);
              // Despite pausing, we may receive additional chunks before previous has completed,
              // in which case we wait until the current write ends.
              if (fileWriter.readyState !== FileWriter.WRITING) {
                writeChunk(chunkByteArray);
              }
            };

            fileWriter.onwriteend = onChunkWritten; // eslint-disable-line no-param-reassign
            fileWriter.onerror = handleError; // eslint-disable-line no-param-reassign

            // // Readable stream.
            // stream
            //   .on('error', handleError)
            //   .on('data', onChunkReceived)
            //   .on('end', () => {
            //     if (bufferedChunkBytes.length === 0) {
            //       resolve(destUrl);
            //     } else {
            //       reachedEndOfInputStream = true;
            //     }
            //   })
            //   .resume();

            const ws = new Writable({
              // Implementing write function
              write(chunk, encoding, callback) {
                // Defining string
                onChunkReceived(chunk);
                callback();
              },
            });
            resolve(ws);
          });
      });
    };
  }

  throw new Error(`writeStream() not available on platform ${environment}`);
});

// FIXME: this implies that it will recursively create directories, but if targetPath's parent
//        doesn't already exist, this will error on both platforms
const ensurePathExists = inEnvironment((environment) => {
  if (environment === environments.ELECTRON) {
    const path = require('path');

    return (targetPath) => {
      const relativePath = path.relative(userDataPath(), targetPath);
      const nestedPaths = getNestedPaths(relativePath)
        .map(pathSegment => path.join(userDataPath(), pathSegment));

      return inSequence(
        nestedPaths,
        createDirectory,
      );
    };
  }

  if (environment === environments.CORDOVA) {
    return targetUrl =>
      inSequence(
        getNestedPaths(targetUrl),
        createDirectory,
      );
  }

  throw new Error(`ensurePathExists() not available on platform ${environment}`);
});

/**
 * Creates a temp file from a given source filename if it doesn't already exist.
 * This is useful on iOS, where video can be served using native file:// URLs.
 * Note that this should not be needed on Android, but if called there, the
 * cache directory will be used.
 *
 * Resolves with the fileEntry of the temp file.
 *
 * @param {string} sourceFilename existing file on the permanent FS
 * @param {string} tmpFilename unique name for the temporary file
 * @async
 *
 */
const makeTmpDirCopy = inEnvironment((environment) => {
  if (environment === environments.CORDOVA) {
    return (sourceFilename, tmpFilename) => new Promise((resolve, reject) => {
      window.requestFileSystem(window.TEMPORARY, 0, (tempFs) => {
        tempFs.root.getFile(tmpFilename, { create: false }, (fileEntry) => {
          resolve(fileEntry); // Temp file already exists
        }, () => {
          window.resolveLocalFileSystemURL(sourceFilename, (sourceEntry) => {
            sourceEntry.copyTo(tempFs.root, tmpFilename, resolve, reject);
          }, reject);
        });
      }, reject);
    });
  }

  throw new Error(`makeTmpDirCopy() not available on platform ${environment}`);
});

module.exports = {
  appPath,
  createDirectory,
  createReader,
  createWriteStream,
  ensurePathExists,
  getFileEntry,
  getFileNativePath,
  getNestedPaths,
  getTempFileSystem,
  inSequence,
  makeFileWriter,
  makeTempDir,
  makeTmpDirCopy,
  newFile,
  readFile,
  removeDirectory,
  rename,
  resolveFileSystemUrl,
  splitUrl,
  tempDataPath,
  userDataPath,
  writeFile,
  writeStream,
};
