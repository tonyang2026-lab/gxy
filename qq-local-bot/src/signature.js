const crypto = require('node:crypto');
function keys(secret) {
  if (!secret) throw new Error('缺少回调验签密钥');
  const bytes = Buffer.from(secret, 'utf8'), seed = Buffer.alloc(32);
  for(let i=0;i<32;i++) seed[i]=bytes[i%bytes.length];
  const privateKey = crypto.createPrivateKey({ key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8' });
  return {privateKey,publicKey:crypto.createPublicKey(privateKey)};
}
function challenge(secret, token, timestamp) {
  if(typeof token!=='string'||typeof timestamp!=='string'||!/^[A-Za-z0-9_+\/=\-]{8,256}$/.test(token))throw new Error('回调验证参数无效');
  return {plain_token:token,signature:crypto.sign(null,Buffer.from(timestamp+token),keys(secret).privateKey).toString('hex')};
}
function verify(secret, timestamp, body, signature, now=Date.now()) {
  if(typeof timestamp!=='string'||!/^\d{10,13}$/.test(timestamp)||typeof signature!=='string'||!/^[a-f\d]{128}$/i.test(signature))return false;
  const time=timestamp.length===13?Number(timestamp):Number(timestamp)*1000;
  if(Math.abs(now-time)>300000)return false;
  try{return crypto.verify(null,Buffer.concat([Buffer.from(timestamp),body]),keys(secret).publicKey,Buffer.from(signature,'hex'));}catch{return false;}
}
module.exports={keys,challenge,verify};
