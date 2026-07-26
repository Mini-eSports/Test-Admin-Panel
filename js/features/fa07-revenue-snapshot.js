/* ADMIN FEATURE A07: Revenue Snapshot Card
   Dashboard pe today/week/month revenue, prizes paid, profit — live. */
(function(){
'use strict';
window.fa07RevenueSnapshot=async function(){
  try{
    var now=Date.now(), dayMs=86400000;
    var todayStart=new Date(); todayStart.setHours(0,0,0,0); todayStart=todayStart.getTime();
    var weekStart=todayStart-6*dayMs;

    var [rSnap,pSnap]=await Promise.all([
      rtdb.ref('platformEarnings').once('value'),
      rtdb.ref('results').orderByChild('timestamp').startAt(weekStart).once('value')
    ]);

    var todayRev=0,weekRev=0,weekPrize=0;
    if(rSnap.exists()) rSnap.forEach(function(c){
      var d=c.val()||{};
      var t=Number(d.timestamp||d.createdAt||0);
      if(t>=todayStart) todayRev+=Number(d.amount||0);
      if(t>=weekStart) weekRev+=Number(d.amount||0);
    });
    if(pSnap.exists()) pSnap.forEach(function(c){
      weekPrize+=Number((c.val()||{}).winnings||0);
    });

    var profit=weekRev-weekPrize;
    var h='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    var cards=[
      ['Today Revenue','₹'+todayRev,'#ffd700'],
      ['Week Revenue','₹'+weekRev,'#00ff9c'],
      ['Week Prizes Paid','₹'+weekPrize,'#ff6b6b'],
      ['Week Profit','₹'+Math.max(0,profit),profit>=0?'#00ff9c':'#ff4444'],
    ];
    cards.forEach(function(c){
      h+='<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px;text-align:center">'
        +'<div style="font-size:11px;color:#aaa;margin-bottom:4px">'+c[0]+'</div>'
        +'<div style="font-size:22px;font-weight:900;color:'+c[2]+'">'+c[1]+'</div></div>';
    });
    h+='</div>';
    showAdminModal('📊 Revenue Snapshot',h);
  }catch(e){showToast('Error: '+e.message,true);}
};
})();
