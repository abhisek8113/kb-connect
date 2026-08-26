import { io } from 'socket.io-client';
const BASE='http://127.0.0.1:4000';
const login=async(u,p)=>(await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json());
const conn=(t)=>new Promise((res,rej)=>{const s=io(BASE,{auth:{token:t}});s.on('connect',()=>res(s));s.on('connect_error',rej);});
let pass=0,fail=0; const check=(n,c)=>{console.log((c?'✅':'❌')+' '+n);c?pass++:fail++;};

const priya=await login('priya','Tutor@12345');
const karthik=await login('karthik','Tutor@12345');
const arjun=await login('arjun','Student@123');
const karan=await login('karan','Student@123');

const sP=await conn(priya.access), sA=await conn(arjun.access), sK=await conn(karan.access), sAdm=await conn((await login('admin','Admin@12345')).access);

// Arjun should get incoming call; Karan should NOT.
let arjunGot=null, karanGot=false, adminSaw=null;
sA.on('call:incoming',p=>arjunGot=p);
sK.on('call:incoming',()=>karanGot=true);
sAdm.on('call:active',p=>adminSaw=p);

// Priya rings Arjun (mapped) -> allowed
const ring=await new Promise(r=>sP.emit('call:ring',{peerId:arjun.user.id,kind:'video'},r));
check('Priya allowed to ring Arjun', ring.ok===true);
await new Promise(r=>setTimeout(r,300));
check('Arjun received incoming call alert', !!arjunGot && arjunGot.from.name==="Priya Ma'am");
check('Karan did NOT receive the alert (privacy)', karanGot===false);
check('Admin saw active call WITHOUT a ring (monitor)', !!adminSaw && adminSaw.callee===arjun.user.id);

// Arjun accepts -> Priya notified
let priyaAccepted=false; sP.on('call:accepted',()=>priyaAccepted=true);
await new Promise(r=>sA.emit('call:accept',{callId:ring.callId},r));
await new Promise(r=>setTimeout(r,200));
check('caller notified on accept', priyaAccepted);

// hangup records duration
const hang=await new Promise(r=>sP.emit('call:hangup',{callId:ring.callId},r));
check('hangup returns duration', typeof hang.duration_secs==='number');

// Karthik (NOT mapped to Arjun) cannot ring Arjun
const badRing=await new Promise(r=>sK && conn(karthik.access).then(sk=>sk.emit('call:ring',{peerId:arjun.user.id},r)));
check('unmapped tutor cannot ring Arjun', badRing.error && !badRing.ok);

// student cannot ring another student
const s2s=await new Promise(r=>sA.emit('call:ring',{peerId:karan.user.id},r));
check('student cannot ring another student', s2s.error && !s2s.ok);

// real-time message + notification
let arjunMsg=null; sA.on('message',m=>arjunMsg=m);
await new Promise(r=>sA.emit('conv:join', ring.conversationId, ()=>r()));
const sent=await new Promise(r=>sP.emit('message:send',{peerId:arjun.user.id,body:'Do exercise 4'},r));
await new Promise(r=>setTimeout(r,200));
check('message delivered in real time', sent.ok && arjunMsg && arjunMsg.body==='Do exercise 4');

console.log(`\n${pass} passed, ${fail} failed`);
[sP,sA,sK,sAdm].forEach(s=>s.close());
process.exit(fail?1:0);
