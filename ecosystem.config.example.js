module.exports = {
  apps: [
    {
      name: "cloud-disk",
      script: "server.js",
      env: {
        PORT: 3100,
        OSS_ACCESS_KEY_ID: "your-access-key-id",
        OSS_ACCESS_KEY_SECRET: "your-access-key-secret",
        OSS_BUCKET_NAME: "your-bucket-name",
        OSS_REGION: "oss-cn-chengdu",
        OSS_ENDPOINT: "oss-cn-chengdu-internal.aliyuncs.com",
        CLOUD_DISK_SESSION_SECRET: "your-random-session-secret",
        CLOUD_DISK_ALLOWED_HOSTS: "your-domain.com,127.0.0.1,localhost"
      }
    }
  ]
};
