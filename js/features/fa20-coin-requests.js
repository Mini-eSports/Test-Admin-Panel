/* ADMIN FEATURE A20: Coin Purchase Request Queue
   Users ne coin khareedne ki request ki → admin ek jagah sab dekhe + approve/reject. */
(function(){
'use strict';
window.fa20CoinRequests=async function(){
  try{
    var s=await rtdb.ref('coinRequests').orderByChild('status').equalTo('pending').once('value');
    var list=[];
    s.forEach(function(c){ var d=c.val(); d._k=c.key; list.push(d); });
    var h='<div>';
    if(!list.length){ h+='<div style="text-align:center;padding:20px;color:#00ff9c">✅ No pending coin requests!</div>'; }
    list.forEach(function(r){
      var ts=new Date(r.createdAt||0).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
      h+='<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px;margin-bottom:8px">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
        +'<div><strong>'+(r.ign||r.userId||'User')+'</strong><div style="font-size:11px;color:#aaa">'+ts+'</div></div>'
        +'<div style="text-align:right"><div style="font-size:16px;font-weight:900;color:#ffd700">🪙 '+(r.coins||0)+'</div>'
        +'<div style="font-size:11px;color:#00ff9c">₹'+(r.amount||0)+'</div></div></div>'
        +(r.utrNumber?'<div style="font-size:11px;color:#aaa;margin-bottom:8px">UTR: <strong>'+r.utrNumber+'</strong></div>':'')
        +'<div style="display:flex;gap:8px">'
        +'<button onclick="fa20Act(\''+r._k+'\',\''+r.userId+'\','+( r.coins||0)+',\'approve\')" style="flex:1;padding:8px;border-radius:8px;background:#00ff9c;color:#000;font-weight:700;border:none;cursor:pointer;font-size:12px">✅ Approve</button>'
        +'<button onclick="fa20Act(\''+r._k+'\',\''+r.userId+'\','+( r.coins||0)+',\'reject\')" style="flex:1;padding:8px;border-radius:8px;background:#ff4444;color:#fff;font-weight:700;border:none;cursor:pointer;font-size:12px">❌ Reject</button>'
        +'</div></div>';
    });
    h+='</div>';
    showAdminModal('🪙 Coin Requests ('+list.length+')',h);
  }catch(e){showToast('Error: '+e.message,true);}
};

window.fa20Act=async function(key,uid,coins,action){
  try{
    await rtdb.ref('coinRequests/'+key).update({status:action,reviewedAt:Date.now()});
    if(action==='approve'){
      await rtdb.ref('users/'+uid+'/coins').transaction(function(c){return(c||0)+coins;});
      // coin history
      var hk=rtdb.ref('users/'+uid+'/coinHistory').push().key;
      await rtdb.ref('users/'+uid+'/coinHistory/'+hk).set({amount:coins,reason:'Coin Purchase',timestamp:Date.now()});
      var nk=rtdb.ref('users/'+uid+'/notifications').push().key;
      await rtdb.ref('users/'+uid+'/notifications/'+nk).set({title:'🪙 Coins Added!',message:coins+' coins tumhare wallet mein add ho gaye!',type:'cashback',timestamp:Date.now(),read:false});
    } else {
      var nk2=rtdb.ref('users/'+uid+'/notifications').push().key;
      await rtdb.ref('users/'+uid+'/notifications/'+nk2).set({title:'❌ Coin Request Rejected',message:'Payment verify nahi hui. Dobara try karo.',type:'system',timestamp:Date.now(),read:false});
    }
    showToast(action==='approve'?'✅ Coins added!':'❌ Rejected');
    fa20CoinRequests();
  }catch(e){showToast('Error: '+e.message,true);}
};
})();
