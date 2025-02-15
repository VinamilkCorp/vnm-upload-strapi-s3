"use strict";
const fp = require("lodash/fp");
const clientS3 = require("@aws-sdk/client-s3");
const credentialProviders = require("@aws-sdk/credential-providers");
const s3RequestPresigner = require("@aws-sdk/s3-request-presigner");
const libStorage = require("@aws-sdk/lib-storage");
const ENDPOINT_PATTERN = /^(.+\.)?s3[.-]([a-z0-9-]+)\./;
function isUrlFromBucket(fileUrl, bucketName, baseUrl = "") {
  const url = new URL(fileUrl);
  if (baseUrl) {
    return false;
  }
  const { bucket } = getBucketFromAwsUrl(fileUrl);
  if (bucket) {
    return bucket === bucketName;
  }
  return url.host.startsWith(`${bucketName}.`) || url.pathname.includes(`/${bucketName}/`);
}
function getBucketFromAwsUrl(fileUrl) {
  const url = new URL(fileUrl);
  if (url.protocol === "s3:") {
    const bucket = url.host;
    if (!bucket) {
      return { err: `Invalid S3 url: no bucket: ${url}` };
    }
    return { bucket };
  }
  if (!url.host) {
    return { err: `Invalid S3 url: no hostname: ${url}` };
  }
  const matches = url.host.match(ENDPOINT_PATTERN);
  if (!matches) {
    return { err: `Invalid S3 url: hostname does not appear to be a valid S3 endpoint: ${url}` };
  }
  const prefix = matches[1];
  if (!prefix) {
    if (url.pathname === "/") {
      return { bucket: null };
    }
    const index2 = url.pathname.indexOf("/", 1);
    if (index2 === -1) {
      return { bucket: url.pathname.substring(1) };
    }
    if (index2 === url.pathname.length - 1) {
      return { bucket: url.pathname.substring(1, index2) };
    }
    return { bucket: url.pathname.substring(1, index2) };
  }
  return { bucket: prefix.substring(0, prefix.length - 1) };
}
const extractCredentials = (options) => {
  if (options.accessKeyId && options.secretAccessKey) {
    return {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey
    };
  }
  if (options.s3Options?.accessKeyId && options.s3Options.secretAccessKey) {
    process.emitWarning(
      "Credentials passed directly to s3Options is deprecated and will be removed in a future release. Please wrap them inside a credentials object."
    );
    return {
      accessKeyId: options.s3Options.accessKeyId,
      secretAccessKey: options.s3Options.secretAccessKey
    };
  }
  if (options.s3Options?.credentials) {
    return {
      accessKeyId: options.s3Options.credentials.accessKeyId,
      secretAccessKey: options.s3Options.credentials.secretAccessKey
    };
  }
  return null;
};
const assertUrlProtocol = (url) => {
  return /^\w*:\/\//.test(url);
};
const getConfig = ({ baseUrl, rootPath, s3Options, ...legacyS3Options }) => {
  if (Object.keys(legacyS3Options).length > 0) {
    process.emitWarning(
      "S3 configuration options passed at root level of the plugin's providerOptions is deprecated and will be removed in a future release. Please wrap them inside the 's3Options:{}' property."
    );
  }
  const credentials = extractCredentials({ s3Options, ...legacyS3Options });
  const config = {
    ...s3Options,
    ...legacyS3Options,
    ...credentials ? { credentials } : {}
  };
  config.params.ACL = fp.getOr(clientS3.ObjectCannedACL.public_read, ["params", "ACL"], config);
  return config;
};
const index = {
  init({ baseUrl, rootPath, s3Options, ...legacyS3Options }) {
    const config = getConfig({ baseUrl, rootPath, s3Options, ...legacyS3Options });
    const filePrefix = rootPath ? `${rootPath.replace(/\/+$/, "")}/` : "";
    const getFileKey = (file) => {
      const path = file.path ? `${file.path}/` : "";
      return `${filePrefix}${path}${file.hash}${file.ext}`;
    };
    const upload = async (file, customParams = {}) => {
      const s3Client = new clientS3.S3Client({
        ...config,
        credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_ACCESS_SECRET ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_ACCESS_SECRET
        } : credentialProviders.fromHttp({
          awsContainerCredentialsFullUri: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
          awsContainerAuthorizationTokenFile: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
        })
      });
      const fileKey = await getFileKey(file);
      const uploadObj = await new libStorage.Upload({
        client: s3Client,
        params: {
          Bucket: config.params.Bucket,
          Key: fileKey,
          Body: file.stream || Buffer.from(file.buffer, "binary"),
          ACL: config.params.ACL,
          ContentType: file.mime,
          ...customParams
        }
      });
      const upload2 = await uploadObj.done();
      if (assertUrlProtocol(upload2.Location)) {
        file.url = baseUrl ? `${baseUrl}/${fileKey}` : upload2.Location;
      } else {
        file.url = `https://${upload2.Location}`;
      }
      s3Client.destroy();
    };
    return {
      isPrivate() {
        return config.params.ACL === "private";
      },
      async getSignedUrl(file, customParams) {
        const s3Client = new clientS3.S3Client({
          ...config,
          credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_ACCESS_SECRET ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_ACCESS_SECRET
          } : credentialProviders.fromHttp({
            awsContainerCredentialsFullUri: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
            awsContainerAuthorizationTokenFile: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
          })
        });
        if (!isUrlFromBucket(file.url, config.params.Bucket, baseUrl)) {
          return { url: file.url };
        }
        const fileKey = getFileKey(file);
        const url = await s3RequestPresigner.getSignedUrl(
          s3Client,
          new clientS3.GetObjectCommand({
            Bucket: config.params.Bucket,
            Key: fileKey,
            ...customParams
          }),
          {
            expiresIn: fp.getOr(15 * 60, ["params", "signedUrlExpires"], config)
          }
        ).finally(() => {
          console.log("detroy client!!");
          s3Client.destroy();
        });
        return { url };
      },
      async uploadStream(file, customParams = {}) {
        return upload(file, customParams);
      },
      async upload(file, customParams = {}) {
        return upload(file, customParams);
      },
      async delete(file, customParams = {}) {
        const s3Client = new clientS3.S3Client({
          ...config,
          credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_ACCESS_SECRET ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_ACCESS_SECRET
          } : credentialProviders.fromHttp({
            awsContainerCredentialsFullUri: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
            awsContainerAuthorizationTokenFile: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
          })
        });
        const command = await new clientS3.DeleteObjectCommand({
          Bucket: config.params.Bucket,
          Key: getFileKey(file),
          ...customParams
        });
        return await s3Client.send(command).finally(() => {
          console.log("detroy client!!");
          s3Client.destroy();
        });
      }
    };
  }
};
module.exports = index;
//# sourceMappingURL=index.js.map
