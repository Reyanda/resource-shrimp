(function() {
    'use strict';
    var type='video', quality='1080p', audioFmt=null, audioMode='video', subs=false, artFmt='pdf', poll=null;
    var input=document.getElementById('urlInput');
    var debounce;

    input.addEventListener('input', function(){clearTimeout(debounce);var u=input.value.trim();u.length>8?debounce=setTimeout(function(){det(u)},300):hideType()});
    input.addEventListener('keydown', function(e){if(e.key==='Enter')startDownload()});

    function det(u){
        u=u.toLowerCase();
        if(/^10\.\d{4,}/.test(u)||/doi\.org\/10\./.test(u))return showT('doi','\u{1F4C4}','Academic Paper (DOI)','DOI resolution');
        if(u.includes('arxiv.org'))return showT('arxiv','\u{1F4D1}','arXiv Paper','Preprint');
        if(u.includes('pubmed')||u.includes('ncbi.nlm.nih.gov'))return showT('pubmed','\u{1F3E5}','PubMed','Medical literature');
        if(/springer|wiley|sciencedirect|nature\.com|science\.org|ieee|acm/.test(u))return showT('academic','\u{1F4DA}','Academic Article','Journal article');
        showT('video','\u{1F3AC}','Video','YouTube, Vimeo, TikTok + 1000 more');
    }

    function showT(t,icon,label,hint){
        type=t;document.getElementById('typeIcon').textContent=icon;
        document.getElementById('typeLabel').textContent=label;
        document.getElementById('typeHint').textContent=hint;
        document.getElementById('typeBadge').classList.add('active');
        document.getElementById('optionsPanel').classList.add('active');
        document.getElementById('videoOptions').style.display=t==='video'?'block':'none';
        document.getElementById('articleOptions').style.display=t!=='video'?'block':'none';
    }

    function hideType(){document.getElementById('typeBadge').classList.remove('active');document.getElementById('optionsPanel').classList.remove('active');type='video'}

    window.pickQ=function(el){document.querySelectorAll('.quality-card').forEach(function(c){c.classList.remove('selected')});el.classList.add('selected');quality=el.dataset.q};
    window.setMode=function(m){audioMode=m;document.querySelectorAll('.audio-toggle-btn').forEach(function(b){b.classList.toggle('active',b.dataset.mode===m)});document.getElementById('audioFormats').classList.toggle('active',m==='audio');document.querySelectorAll('.quality-card').forEach(function(c){c.style.opacity=m==='audio'?'0.4':'1'});if(m==='audio'){quality='audio';document.querySelectorAll('.quality-card').forEach(function(c){c.classList.remove('selected')})}else{var d=document.querySelector('.quality-card[data-q="1080p"]');if(d){d.classList.add('selected');quality='1080p'}}};
    window.pickA=function(el){document.querySelectorAll('.audio-chip[data-fmt]').forEach(function(c){c.classList.remove('selected')});el.classList.add('selected');audioFmt=el.dataset.fmt};
    window.pickArt=function(el){document.querySelectorAll('#articleOptions .audio-chip').forEach(function(c){c.classList.remove('selected')});el.classList.add('selected');artFmt=el.dataset.fmt};
    window.togSub=function(){subs=!subs;document.getElementById('subToggle').classList.toggle('active',subs)};

    window.startDownload=function(){
        var url=input.value.trim();if(!url)return;
        var btn=document.getElementById('downloadBtn');
        btn.classList.add('loading');btn.disabled=true;
        document.getElementById('progressSection').classList.add('active');
        resetProg();showSt('loading','Resolving...');

        fetch('/api/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,type:type==='video'?'auto':type,quality:quality,format:audioMode==='audio'?(audioFmt||'mp3'):'mp4',subtitles:subs})})
        .then(function(res){return res.json()})
        .then(function(d){if(d.error)throw new Error(d.error);pollSt(d.download_id,d.type)})
        .catch(function(e){showSt('error',e.message||'Failed')})
        .finally(function(){btn.classList.remove('loading');btn.disabled=false});
    };

    function pollSt(id,dlType){
        poll=setInterval(function(){
            fetch('/api/status/'+encodeURIComponent(id))
            .then(function(r){return r.json()})
            .then(function(d){
                if(d.status==='error'){clearInterval(poll);showSt('error',d.message||d.error)}
                else if(d.status==='complete'){clearInterval(poll);updProg(d);setPh('ready');showSt('success','Ready \u2014 downloading');triggerDl(id)}
                else{updProg(d);setPh(d.phase||d.status)}
            })
            .catch(function(){clearInterval(poll);showSt('error','Connection lost')});
        },400);
    }

    function updProg(d){
        var p=d.progress||'0';
        document.getElementById('progressFill').style.width=p+'%';
        document.getElementById('statProgress').textContent=p+'%';
        document.getElementById('statSpeed').textContent=d.speed||'\u2014';
        document.getElementById('statEta').textContent=d.eta||'\u2014';
        var l={starting:'Init',downloading:'Download',fetching:'Fetch',processing:'Process',encoding:'Encode',complete:'Done'};
        document.getElementById('statStatus').textContent=l[d.status]||d.status;

        if(d.type==='article'&&d.title){
            document.getElementById('paperInfo').classList.add('active');
            document.getElementById('paperTitle').textContent=d.title;
            document.getElementById('paperAuthors').textContent=(d.authors||[]).join(', ');
            document.getElementById('paperDoi').textContent=d.doi||'';
            document.getElementById('paperJournal').textContent=d.journal||'';
            document.getElementById('paperYear').textContent=d.year||'';
        }

        var st=d.status==='complete'?'success':'loading';
        showSt(st,d.message||'Working...');
    }

    function setPh(p){
        ['phase1','phase2','phase3'].forEach(function(id){document.getElementById(id).className='phase'});
        if(['init','starting','downloading','fetching'].indexOf(p)!==-1)document.getElementById('phase1').classList.add('active');
        else if(['processing','encoding'].indexOf(p)!==-1){document.getElementById('phase1').classList.add('done');document.getElementById('phase2').classList.add('active')}
        else if(['ready','complete'].indexOf(p)!==-1){document.getElementById('phase1').classList.add('done');document.getElementById('phase2').classList.add('done');document.getElementById('phase3').classList.add('active')}
    }

    function resetProg(){document.getElementById('progressFill').style.width='0%';document.getElementById('statProgress').textContent='0%';document.getElementById('statSpeed').textContent='\u2014';document.getElementById('statEta').textContent='\u2014';document.getElementById('statStatus').textContent='Waiting';document.getElementById('paperInfo').classList.remove('active');document.getElementById('statusBar').classList.remove('active');['phase1','phase2','phase3'].forEach(function(id){document.getElementById(id).className='phase'})}

    function showSt(t,msg){var b=document.getElementById('statusBar');b.className='status-bar active '+t;document.getElementById('statusMsg').textContent=msg}

    function triggerDl(id){var a=document.createElement('a');a.href='/api/stream/'+encodeURIComponent(id);a.style.display='none';document.body.appendChild(a);a.click();setTimeout(function(){a.remove()},1000)}

    // Institution
    var insts=[
        {n:'MIT',r:'USA'},{n:'Harvard',r:'USA'},{n:'Stanford',r:'USA'},{n:'Oxford',r:'UK'},
        {n:'Cambridge',r:'UK'},{n:'ETH Zurich',r:'Switzerland'},{n:'U of Tokyo',r:'Japan'},
        {n:'NUS',r:'Singapore'},{n:'U of Cape Town',r:'South Africa'},{n:'U of Nairobi',r:'Kenya'},
        {n:'Makerere',r:'Uganda'},{n:'U of Ghana',r:'Ghana'},{n:'U of Malaya',r:'Malaysia'},
        {n:'U of S\u00e3o Paulo',r:'Brazil'},{n:'IISc',r:'India'},{n:'Tsinghua',r:'China'},
        {n:'Seoul National',r:'South Korea'},{n:'U of Buenos Aires',r:'Argentina'},
    ];
    window.openInst=function(){document.getElementById('instModal').classList.add('active');filterInst('')};
    window.filterInst=function(q){document.getElementById('instList').innerHTML=insts.filter(function(i){return i.n.toLowerCase().indexOf(q.toLowerCase())!==-1||i.r.toLowerCase().indexOf(q.toLowerCase())!==-1}).map(function(i){return '<div class="inst-item" data-url="https://login.research4life.org/" onclick="window.open(this.dataset.url,\'_blank\');document.getElementById(\'instModal\').classList.remove(\'active\')"><div class="inst-icon">\u{1F3DB}\uFE0F</div><div><div class="inst-name">'+i.n+'</div><div class="inst-region">'+i.r+'</div></div></div>'}).join('')};
    window.openR4L=function(){document.getElementById('r4lModal').classList.add('active')};
    window.openSH=function(){var u=input.value.trim();var m=u.match(/10\.\d{4,}\/[^\s&?]+/);window.open(m?'https://sci-hub.su/'+m[0]:'https://sci-hub.su','_blank')};
    window.openOA=function(){var u=input.value.trim();var m=u.match(/10\.\d{4,}\/[^\s&?]+/);window.open(m?'https://api.unpaywall.org/v2/'+m[0]+'?email=dl@rs.app':'https://unpaywall.org','_blank')};
})();
