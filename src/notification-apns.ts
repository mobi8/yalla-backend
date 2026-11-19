import { connect } from 'node:http2';
import { createPrivateKey, sign, createHash } from 'node:crypto';
import type { NotificationEvent, readNotificationPolicy } from './notification-events.js';

export function apnsClient(config:ReturnType<typeof readNotificationPolicy>['apns'], key:string) {
  const privateKey = createPrivateKey(key);
  const encode = (value:object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({alg:'ES256',kid:config.keyId})+'.'+encode({iss:config.teamId,iat:Math.floor(Date.now()/1000)});
  const jwt = unsigned+'.'+sign('sha256',Buffer.from(unsigned),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  return async (token:string,event:NotificationEvent,message:{title:string;body:string}) => new Promise<number>((resolve,reject) => {
    const host = config.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    const connection = connect('https://'+host);
    const timeout = setTimeout(() => {connection.destroy();reject(new Error('APNS_TIMEOUT'));},6000);
    connection.once('error',reject);
    const stream = connection.request({':method':'POST',':path':'/3/device/'+token,authorization:'bearer '+jwt,
      'apns-topic':config.bundleId,'apns-push-type':'alert',
      'apns-collapse-id':createHash('sha256').update(event.eventId).digest('hex')});
    let status = 0;
    stream.on('response',headers => {status=Number(headers[':status']);});
    stream.on('error',reject);
    stream.on('data',()=>{});
    stream.on('end',()=>{clearTimeout(timeout);connection.close();resolve(status);});
    stream.end(JSON.stringify({aps:{alert:message},eventId:event.eventId,eventType:event.eventType,recipientPlayerId:event.recipientPlayerId}));
  });
}
