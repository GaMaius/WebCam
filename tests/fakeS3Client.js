function createFakeS3Client() {
  const calls = [];
  let uploadIdCounter = 0;
  let etagCounter = 0;

  return {
    calls,
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });

      if (name === 'CreateMultipartUploadCommand') {
        uploadIdCounter += 1;
        return { UploadId: `fake-upload-${uploadIdCounter}` };
      }
      if (name === 'UploadPartCommand') {
        etagCounter += 1;
        return { ETag: `"fake-etag-${etagCounter}"` };
      }
      if (name === 'CompleteMultipartUploadCommand') {
        return {};
      }
      throw new Error(`createFakeS3Client: unexpected command ${name}`);
    },
  };
}

module.exports = { createFakeS3Client };
