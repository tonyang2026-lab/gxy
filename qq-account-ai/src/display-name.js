function displayName(sender={}){
 const clean=value=>typeof value==='string'?Array.from(value.replace(/\[CQ:[^\]]*\]|<[^>]*>/g,'').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069@]/g,'').trim()).slice(0,24).join(''):'';
 return clean(sender?.card)||clean(sender?.nickname)||'';
}
module.exports={displayName};
