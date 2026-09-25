// Local development without a Freestyle account: a Docker container stands in
// for the sandbox and MinIO for S3. Start them first:
//   docker network create vols
//   docker run -d --name minio --network vols -p 127.0.0.1:9000:9000 -e MINIO_ROOT_USER=admin -e MINIO_ROOT_PASSWORD=adminadmin cgr.dev/chainguard/minio server /data
//   docker run -d --name sandbox --network vols --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined --entrypoint sh rclone/rclone -c 'sleep 3600'
// and create the bucket "volumes" in MinIO (console at http://127.0.0.1:9000 or `mc mb`).
import { FreestyleVolumes } from 'freestyle-volumes';
import { dockerSandboxes } from 'freestyle-volumes/docker';

const volumes = new FreestyleVolumes({
  storage: {
    endpoint: 'http://127.0.0.1:9000', // how this process reaches MinIO
    sandboxEndpoint: 'http://minio:9000', // how the container reaches MinIO
    bucket: 'volumes',
    accessKeyId: 'admin',
    secretAccessKey: 'adminadmin',
    provider: 'Minio',
  },
  sandboxes: dockerSandboxes(),
});

const volume = await volumes.get('scratch', { create: true });
await volumes.attach({ sandboxId: 'sandbox', volumeId: volume.id, mountPath: '/mnt/scratch' });
console.log(await volumes.inspectMount({ sandboxId: 'sandbox', mountPath: '/mnt/scratch' }));
console.log(await volumes.detach({ sandboxId: 'sandbox', mountPath: '/mnt/scratch' }));
