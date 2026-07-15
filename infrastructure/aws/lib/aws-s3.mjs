/** @typedef {ReturnType<import("./aws-api.mjs").createAwsClient>} AwsClient */
/** @typedef {import("./aws-config.mjs").NormalizedS3Bucket} NormalizedS3Bucket */
/** @typedef {import("./aws-plan.mjs").AwsPlanAction} AwsPlanAction */

/**
 * @param {AwsClient} client
 * @param {NormalizedS3Bucket} bucket
 */
export async function createS3Bucket(client, bucket) {
  await client.s3("PUT", bucket.name, "/", { "x-amz-acl": "private" });
  if (bucket.versioning) {
    const body = "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>";
    await client.s3("PUT", bucket.name, "/?versioning", { "content-type": "application/xml" }, body);
  }
  if (bucket.encryption) {
    const body =
      '<ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>';
    await client.s3("PUT", bucket.name, "/?encryption", { "content-type": "application/xml" }, body);
  }
  return { aws_id: bucket.name, resource_id: bucket.id };
}

/**
 * @param {AwsClient} client
 * @param {AwsPlanAction} action
 */
export async function applyS3Action(client, action) {
  const d = /** @type {NormalizedS3Bucket} */ (/** @type {Record<string, unknown>} */ (action.desired));
  if (action.action === "create") {
    return createS3Bucket(client, d);
  }
  if (action.action === "delete" && action.live?.aws_id) {
    await client.s3("DELETE", String(action.live.aws_id), "/");
    return { resource_id: action.resource_id, deleted: true };
  }
  return null;
}
