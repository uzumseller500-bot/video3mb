'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const MAX_BYTES = 3_000_000;
const QUALITY_TARGET = 2_850_000;
const FAST_TARGET = 2_720_000;
const MIN_VIDEO_K = 90;
const AUDIO_K = 32;
const AUTO_WATERMARK_TEXT = 'VIDEO3MB';

const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const fmtSize=(b=0)=>b<1024*1024?Math.round(b/1024)+' KB':(b/1024/1024).toFixed(2)+' MB';
const fmtTime=(s=0)=>{
  const n=Math.max(0,Math.floor(s));
  return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
};

export default function Home(){
  const [file,setFile]=useState(null);
  const [src,setSrc]=useState('');
  const [duration,setDuration]=useState(0);
  const [sourceW,setSourceW]=useState(0);
  const [sourceH,setSourceH]=useState(0);
  const [currentTime,setCurrentTime]=useState(0);

  const [active,setActive]=useState('auto');
  const [start,setStart]=useState(0);
  const [end,setEnd]=useState(0);
  const [fit,setFit]=useState('cover');
  const [focusX,setFocusX]=useState(50);
  const [focusY,setFocusY]=useState(50);
  const [speed,setSpeed]=useState(1);
  const [audio,setAudio]=useState('keep');
  const [volume,setVolume]=useState(100);

  const [brightness,setBrightness]=useState(100);
  const [contrast,setContrast]=useState(100);
  const [saturation,setSaturation]=useState(100);
  const [sharpness,setSharpness]=useState(28);

  const [quality,setQuality]=useState('quality');
  const [status,setStatus]=useState('idle');
  const [progress,setProgress]=useState(0);
  const [message,setMessage]=useState('');
  const [outUrl,setOutUrl]=useState('');
  const [outSize,setOutSize]=useState(0);
  const [validation,setValidation]=useState(null);

  const videoRef=useRef(null);
  const cropDragRef=useRef(null);
  const ffmpegRef=useRef(null);
  const enginePromiseRef=useRef(null);
  const lastLogRef=useRef('');
  const phaseRef=useRef('idle');

  const clipDuration=useMemo(()=>Math.max(.1,end-start),[start,end]);
  const outputDuration=useMemo(()=>Math.max(.1,clipDuration/speed),[clipDuration,speed]);
  const fps=outputDuration<=20?24:20;
  const targetBytes=quality==='quality'?QUALITY_TARGET:FAST_TARGET;
  const estimatedVideoK=useMemo(()=>{
    const total=Math.floor(targetBytes*8/outputDuration/1000);
    return Math.max(MIN_VIDEO_K,total-(audio==='mute'?0:AUDIO_K)-20);
  },[targetBytes,outputDuration,audio]);
  const qualityLabel=estimatedVideoK>=950?'A’lo':estimatedVideoK>=600?'Yaxshi':'Siqilgan';

  useEffect(()=>()=>{ if(src) URL.revokeObjectURL(src); if(outUrl) URL.revokeObjectURL(outUrl); },[src,outUrl]);

  useEffect(()=>{
    const onKey=(e)=>{
      if(!file) return;
      if(e.code==='Space' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)){
        e.preventDefault();
        const v=videoRef.current;
        if(v) v.paused?v.play():v.pause();
      }
      if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){
        e.preventDefault();
        if(status!=='processing') exportVideo();
      }
    };
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  });

  function resetProject(){
    if(src) URL.revokeObjectURL(src);
    if(outUrl) URL.revokeObjectURL(outUrl);
    setFile(null);setSrc('');setOutUrl('');setValidation(null);setStatus('idle');setProgress(0);setMessage('');
  }

  function pick(f){
    if(!f) return;
    if(!f.type.startsWith('video/')){setMessage('Video fayl tanlang.');return;}
    if(src) URL.revokeObjectURL(src);
    if(outUrl) URL.revokeObjectURL(outUrl);
    setFile(f);setSrc(URL.createObjectURL(f));setOutUrl('');setOutSize(0);setValidation(null);
    setCurrentTime(0);setFocusX(50);setFocusY(50);setStatus('idle');setProgress(0);
    setMessage('Video yuklandi. Tahrirlash mumkin.');
  }

  function applyUzumAuto(){
    setFit('cover');
    setFocusX(50);setFocusY(50);
    setQuality('quality');
    setBrightness(100);setContrast(100);setSaturation(100);setSharpness(28);
    setActive('auto');
    setValidation(null);
    setMessage('UZUM AUTO: 1080×1440 · 3:4 · 3 MB limit · sifat ustuvor.');
  }

  function seekTimeline(e){
    if(!duration||!videoRef.current) return;
    const r=e.currentTarget.getBoundingClientRect();
    const t=clamp((e.clientX-r.left)/Math.max(1,r.width),0,1)*duration;
    videoRef.current.currentTime=t;
    setCurrentTime(t);
  }

  function onCanvasDown(e){
    const r=e.currentTarget.getBoundingClientRect();
    if(active==='canvas'&&fit==='cover'){
      cropDragRef.current={x:e.clientX,y:e.clientY,fx:focusX,fy:focusY,rect:r};
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  }

  function onCanvasMove(e){
    if(cropDragRef.current&&active==='canvas'&&fit==='cover'){
      const d=cropDragRef.current,r=d.rect;
      setFocusX(clamp(d.fx-(e.clientX-d.x)/r.width*100,0,100));
      setFocusY(clamp(d.fy-(e.clientY-d.y)/r.height*100,0,100));
    }
  }

  function onCanvasUp(e){
    cropDragRef.current=null;
    try{e.currentTarget.releasePointerCapture?.(e.pointerId)}catch{}
  }

  async function withTimeout(promise,ms,label,onTimeout){
    let timer;
    try{
      return await Promise.race([
        promise,
        new Promise((_,reject)=>{timer=setTimeout(()=>{try{onTimeout?.()}catch{};reject(new Error(label+' timeout'));},ms);})
      ]);
    }finally{clearTimeout(timer);}
  }

  async function loadEngine(){
    if(ffmpegRef.current) return ffmpegRef.current;
    if(enginePromiseRef.current) return enginePromiseRef.current;

    enginePromiseRef.current=(async()=>{
      setProgress(4);setMessage('Video dvigateli yuklanmoqda...');
      phaseRef.current='engine';
      lastLogRef.current='';

      const make=()=>{
        const ffmpeg=new FFmpeg();
        ffmpeg.on('progress',({progress:p})=>{
          const pct=12+Math.round(clamp(p||0,0,1)*75);
          setProgress(v=>Math.max(v,Math.min(88,pct)));
        });
        ffmpeg.on('log',({message:m})=>{
          if(m) lastLogRef.current=String(m).slice(-240);
        });
        return ffmpeg;
      };

      const sources=[
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd',
        'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd'
      ];
      let lastErr=null;

      for(const base of sources){
        const ffmpeg=make();
        try{
          await withTimeout(ffmpeg.load({
            coreURL:await toBlobURL(base+'/ffmpeg-core.js','text/javascript'),
            wasmURL:await toBlobURL(base+'/ffmpeg-core.wasm','application/wasm')
          }),45000,'engine',()=>{try{ffmpeg.terminate()}catch{}});
          ffmpegRef.current=ffmpeg;
          return ffmpeg;
        }catch(err){
          lastErr=err;
          try{ffmpeg.terminate()}catch{}
        }
      }
      throw lastErr||new Error('FFmpeg engine load failed');
    })();

    try{return await enginePromiseRef.current;}
    finally{enginePromiseRef.current=null;}
  }

  function baseFilter(){
    const scaleFlags=quality==='quality'?'lanczos':'bicubic';
    const bright=((brightness-100)/100).toFixed(2);
    const con=(contrast/100).toFixed(2);
    const sat=(saturation/100).toFixed(2);
    const eq=',eq=brightness='+bright+':contrast='+con+':saturation='+sat;
    const sharp=sharpness>0?',unsharp=5:5:'+(sharpness/100*.42).toFixed(2)+':3:3:0':'';
    const speedFilter=speed===1?'':',setpts=PTS/'+speed;

    if(fit==='contain'){
      return 'scale=1080:1440:force_original_aspect_ratio=decrease:flags='+scaleFlags+
        ',pad=1080:1440:(ow-iw)/2:(oh-ih)/2:black'+eq+sharp+',fps='+fps+speedFilter+',setsar=1,setdar=3/4';
    }

    const px=(focusX/100).toFixed(4);
    const py=(focusY/100).toFixed(4);
    return 'scale=1080:1440:force_original_aspect_ratio=increase:flags='+scaleFlags+
      ',crop=1080:1440:(iw-1080)*'+px+':(ih-1440)*'+py+eq+sharp+',fps='+fps+speedFilter+',setsar=1,setdar=3/4';
  }


  async function makeAutoWatermark(ffmpeg){
    phaseRef.current='auto watermark';
    const canvas=document.createElement('canvas');
    canvas.width=520;
    canvas.height=140;
    const x=canvas.getContext('2d',{willReadFrequently:true});
    x.clearRect(0,0,canvas.width,canvas.height);
    x.save();
    x.filter='blur(24px)';
    x.globalAlpha=0.018;
    x.fillStyle='#ffffff';
    x.font='900 82px Arial';
    x.textAlign='center';
    x.textBaseline='middle';
    x.fillText(AUTO_WATERMARK_TEXT,canvas.width/2,canvas.height/2);
    x.restore();

    const pixels=x.getImageData(0,0,canvas.width,canvas.height).data;
    const copy=new Uint8Array(pixels.length);
    copy.set(pixels);
    await ffmpeg.writeFile('auto-watermark.rgba',copy);
    return {w:canvas.width,h:canvas.height};
  }

  function audioTempo(v){
    if(v<=2) return 'atempo='+v;
    return 'atempo=2,atempo='+(v/2);
  }

  function videoCodecArgs(videoK,safe=false){
    const vk=Math.max(MIN_VIDEO_K,Math.floor(videoK));
    const preset=safe?'superfast':(quality==='quality'?'veryfast':'superfast');
    const args=[
      '-c:v','libx264','-preset',preset,
      '-pix_fmt','yuv420p',
      '-b:v',vk+'k',
      '-maxrate',Math.floor(vk*1.03)+'k',
      '-bufsize',Math.floor(vk*1.6)+'k',
      '-movflags','+faststart'
    ];
    if(!safe) args.push('-profile:v','high','-level','4.1');
    args.push('-metadata:s:v:0','rotate=0','-map_metadata','-1');
    return args;
  }

  async function execChecked(ffmpeg,args,label,timeoutMs){
    phaseRef.current=label;
    lastLogRef.current='';
    const code=await withTimeout(
      ffmpeg.exec(args),
      timeoutMs,
      label,
      ()=>{try{ffmpeg.terminate()}catch{};ffmpegRef.current=null;}
    );
    if(code!==0){
      throw new Error(label+' exit '+code+(lastLogRef.current?' · '+lastLogRef.current:''));
    }
  }

  async function runEncode(ffmpeg,inputName,videoK,attempt,wm,audioK){
    const out='out-'+attempt+'.mp4';

    const build=(safe=false,withVisual=true)=>{
      const args=['-ss',start.toFixed(3),'-i',inputName];

      if(withVisual){
        args.push(
          '-f','rawvideo',
          '-pix_fmt','rgba',
          '-video_size',wm.w+'x'+wm.h,
          '-framerate','1',
          '-i','auto-watermark.rgba'
        );
      }

      args.push('-t',outputDuration.toFixed(3));

      if(withVisual){
        args.push(
          '-filter_complex',
          '[0:v]'+baseFilter()+'[base];[base][1:v]overlay=(W-w)/2:(H-h)/2:eof_action=repeat:repeatlast=1:shortest=0[v]',
          '-map','[v]'
        );
      }else{
        args.push('-vf',baseFilter(),'-map','0:v:0');
      }

      args.push(...videoCodecArgs(videoK,safe));

      if(audio==='mute'){
        args.push('-an');
      }else{
        args.push('-map','0:a?','-c:a','aac','-b:a',audioK+'k');
        const af=[];
        if(speed!==1) af.push(audioTempo(speed));
        if(volume!==100) af.push('volume='+(volume/100).toFixed(2));
        if(af.length) args.push('-af',af.join(','));
      }

      // Watermark matni metadata ichida ham saqlanadi — video ustidagi yozuv juda xira bo‘lsa ham identifikator qoladi.
      args.push(
        '-metadata','comment='+AUTO_WATERMARK_TEXT,
        '-metadata','copyright='+AUTO_WATERMARK_TEXT,
        '-y',out
      );
      return args;
    };

    setMessage('Avtomatik xira watermark bilan video tayyorlanmoqda...');
    try{
      await execChecked(ffmpeg,build(false,true),'auto watermark encode',180000);
    }catch(firstErr){
      if(!ffmpegRef.current) throw firstErr;
      try{await ffmpeg.deleteFile(out)}catch{}
      setProgress(v=>Math.max(v,16));
      setMessage('Watermark SAFE rejimda tayyorlanmoqda...');
      try{
        await execChecked(ffmpeg,build(true,true),'auto watermark safe encode',180000);
      }catch(secondErr){
        if(!ffmpegRef.current) throw secondErr;
        try{await ffmpeg.deleteFile(out)}catch{}
        // Vizual watermark filter ishlamasa eksportni buzmaymiz:
        // watermark matni MP4 metadata ichida yashirin holda avtomatik saqlanadi.
        setMessage('Yashirin watermark rejimida video tayyorlanmoqda...');
        await execChecked(ffmpeg,build(true,false),'hidden watermark encode',180000);
      }
    }

    const bytes=await ffmpeg.readFile(out);
    try{await ffmpeg.deleteFile(out)}catch{}
    return new Uint8Array(bytes);
  }

  async function validateBlob(blob){
    return await new Promise(resolve=>{
      const u=URL.createObjectURL(blob);
      const v=document.createElement('video');
      const finish=(data)=>{URL.revokeObjectURL(u);resolve(data);};
      v.preload='metadata';
      v.onloadedmetadata=()=>finish({
        width:v.videoWidth,height:v.videoHeight,duration:v.duration,size:blob.size,
        sizeOK:blob.size<=MAX_BYTES,
        dimensionsOK:v.videoWidth===1080&&v.videoHeight===1440,
        ratioOK:Math.abs(v.videoWidth/v.videoHeight-.75)<.001
      });
      v.onerror=()=>finish({width:0,height:0,duration:0,size:blob.size,sizeOK:blob.size<=MAX_BYTES,dimensionsOK:false,ratioOK:false});
      v.src=u;
    });
  }

  async function exportVideo(){
    if(!file||status==='processing') return;
    setStatus('processing');setProgress(2);setValidation(null);setOutUrl('');setOutSize(0);
    try{
      const ffmpeg=await loadEngine();
      setProgress(10);setMessage('Video xotiraga yuklanmoqda...');
      const ext=(file.name.split('.').pop()||'mp4').replace(/[^a-z0-9]/gi,'').toLowerCase();
      const inputName='input.'+(ext||'mp4');
      await ffmpeg.writeFile(inputName,await fetchFile(file));

      const audioK=audio==='mute'?0:AUDIO_K;
      let videoK=Math.max(MIN_VIDEO_K,Math.floor(targetBytes*8/outputDuration/1000)-audioK-20);
      const wm=await makeAutoWatermark(ffmpeg);

      let bytes=await runEncode(ffmpeg,inputName,videoK,1,wm,audioK||AUDIO_K);

      if(bytes.byteLength>MAX_BYTES){
        setProgress(18);setMessage('3 MB limitga aniq moslanmoqda...');
        const ratio=MAX_BYTES/bytes.byteLength;
        videoK=Math.max(MIN_VIDEO_K,Math.floor(videoK*ratio*.91));
        bytes=await runEncode(ffmpeg,inputName,videoK,2,wm,audioK||AUDIO_K);
      }

      try{await ffmpeg.deleteFile(inputName)}catch{}
      try{await ffmpeg.deleteFile('auto-watermark.rgba')}catch{}

      const blob=new Blob([bytes],{type:'video/mp4'});
      const checked=await validateBlob(blob);
      setValidation(checked);
      const u=URL.createObjectURL(blob);
      setOutUrl(u);setOutSize(blob.size);setProgress(100);

      if(checked.sizeOK&&checked.dimensionsOK&&checked.ratioOK){
        setStatus('done');setMessage('UZUM READY · 1080×1440 · 3:4 · 3 MB ichida.');
      }else{
        setStatus('warning');
        setMessage(checked.sizeOK?'Video tayyor, format tekshiruvida muammo bor.':'Video tayyor, lekin 3 MB dan katta.');
      }
    }catch(e){
      console.error(e);
      setStatus('error');setProgress(0);
      const raw=String(e?.message||'Noma’lum xato');
      const detail=lastLogRef.current && !raw.includes(lastLogRef.current) ? ' · '+lastLogRef.current : '';
      if(raw.includes('timeout')){
        setMessage('XATO ['+phaseRef.current+']: vaqt tugadi. '+raw.slice(0,150));
      }else{
        setMessage('XATO ['+phaseRef.current+']: '+(raw+detail).slice(0,260));
      }
    }
  }

  const tools=[
    ['auto','✦','Auto'],['media','＋','Media'],['canvas','▣','Canvas'],['trim','✂','Qirqish'],
    ['speed','⚡','Tezlik'],['audio','♪','Ovoz'],['adjust','◐','Rang'],['export','⇩','Export']
  ];

  if(!file){
    return <main className="landing">
      <nav className="landingNav">
        <div className="brand">VIDEO<span>3MB</span><b>STUDIO</b></div>
        <div className="navBadges"><span>LOCAL</span><span>1080×1440</span><span>≤3 MB</span></div>
      </nav>
      <section className="landingHero">
        <div className="heroEyebrow">UZUM SELLER VIDEO STUDIO</div>
        <h1>Clideo emas. <em>Seller uchun kuchliroq.</em></h1>
        <p>Video tahrirlash, crop, qirqish, tezlik, audio, matn, rang va Uzum’ga tayyor 3 MB eksport — bitta professional workspace’da.</p>
        <label className="uploadHero">
          <input type="file" accept="video/*" onChange={e=>pick(e.target.files?.[0])}/>
          <span className="uploadPlus">＋</span>
          <strong>VIDEO YUKLASH</strong>
          <small>MP4 · MOV · WebM · fayl brauzeringizda ishlanadi</small>
        </label>
        <div className="heroFeatures">
          <span>✓ Login kerak emas</span><span>✓ Auto xira watermark</span><span>✓ Uzum Auto</span><span>✓ Real 3 MB check</span>
        </div>
      </section>
      <section className="featureStrip">
        <div><b>3:4</b><span>Seller canvas</span></div>
        <div><b>1080×1440</b><span>Aniq eksport</span></div>
        <div><b>3,000,000</b><span>Byte limiti</span></div>
        <div><b>H.264</b><span>MP4 output</span></div>
      </section>
    </main>;
  }

  return <main className="studio">
    <header className="topbar">
      <div className="brand small">VIDEO<span>3MB</span><b>STUDIO</b></div>
      <div className="projectMeta">
        <strong>{file.name}</strong>
        <span>{sourceW||'—'}×{sourceH||'—'} · {fmtSize(file.size)} · {fmtTime(duration)}</span>
      </div>
      <div className="topbarActions">
        <button className="secondary" onClick={resetProject}>＋ Yangi video</button>
        <button className="uzumBtn" onClick={applyUzumAuto}>✦ UZUM AUTO</button>
      </div>
    </header>

    <div className="workspace">
      <aside className="rail">
        {tools.map(([id,icon,label])=><button key={id} onClick={()=>setActive(id)} className={active===id?'on':''}><b>{icon}</b><span>{label}</span></button>)}
      </aside>

      <section className="center">
        <div className="stageHeader">
          <div className="stageTags"><span>3:4</span><span>1080×1440</span><span>≤ 3 MB</span></div>
          <div className="stageActions"><span>{quality==='quality'?'✨ Sifat':'⚡ Tez'}</span><span>{fps} FPS</span></div>
        </div>

        <div className="stage">
          <div className="canvas" onPointerDown={onCanvasDown} onPointerMove={onCanvasMove} onPointerUp={onCanvasUp} onPointerCancel={onCanvasUp}>
            <video ref={videoRef} src={src} controls playsInline
              style={{objectFit:fit==='cover'?'cover':'contain',objectPosition:focusX+'% '+focusY+'%'}}
              onTimeUpdate={e=>setCurrentTime(e.currentTarget.currentTime||0)}
              onLoadedMetadata={e=>{const v=e.currentTarget,d=v.duration||0;setDuration(d);setStart(0);setEnd(d);setSourceW(v.videoWidth||0);setSourceH(v.videoHeight||0);}}
            />
            <div className="safe"><span>SAFE 1080×1440</span></div>
            <div className="autoWatermarkPreview">{AUTO_WATERMARK_TEXT}</div>
            {active==='canvas'&&fit==='cover'&&<div className="canvasHint">↔ Videoni tortib fokusni tanlang</div>}
          </div>
        </div>

        <div className="timelinePanel">
          <div className="timelineTop"><strong>Timeline</strong><span>{fmtTime(currentTime)} / {fmtTime(duration)}</span></div>
          <div className="timeline" onClick={seekTimeline}>
            <div className="dim left" style={{width:(duration?start/duration*100:0)+'%'}}/>
            <div className="clip" style={{left:(duration?start/duration*100:0)+'%',width:(duration?(end-start)/duration*100:100)+'%'}}>
              <span>VIDEO</span>
            </div>
            <div className="head" style={{left:(duration?currentTime/duration*100:0)+'%'}}/>
          </div>
          <div className="timelineFoot">
            <span>Boshi <b>{start.toFixed(1)}s</b></span>
            <span>Oxiri <b>{end.toFixed(1)}s</b></span>
            <span>Chiqish <b>{outputDuration.toFixed(1)}s</b></span>
            <span>Space = Play/Pause</span>
          </div>
        </div>
      </section>

      <aside className="inspector">
        <div className="inspectorTitle">
          <div><strong>{active==='auto'?'Uzum Auto':active==='media'?'Media':active==='canvas'?'Canvas':active==='trim'?'Qirqish':active==='speed'?'Tezlik':active==='audio'?'Ovoz':active==='adjust'?'Rang / Tiniqlik':'Export'}</strong><span>VIDEO3MB Studio</span></div>
        </div>

        {active==='auto'&&<div className="panel">
          <div className="autoCard"><i>✦</i><h2>1 bosishda Uzum</h2><p>1080×1440 · 3:4 · H.264 · 3 MB limit.</p><button onClick={applyUzumAuto}>AUTO SOZLASH</button></div>
          <div className="statGrid"><div><small>Format</small><b>1080×1440</b></div><div><small>Limit</small><b>3.00 MB</b></div><div><small>FPS</small><b>{fps}</b></div><div><small>Sifat</small><b>{qualityLabel}</b></div></div>
          <div className="qualityBar"><span style={{width:Math.min(100,estimatedVideoK/12)+'%'}}/><b>~{estimatedVideoK} kbps</b></div>
        </div>}

        {active==='media'&&<div className="panel">
          <h3>Media</h3>
          <div className="mediaCard"><div className="mediaThumb">▶</div><div><b>{file.name}</b><span>{sourceW}×{sourceH} · {fmtSize(file.size)}</span></div></div>
          <label className="replaceBtn">Video almashtirish<input type="file" accept="video/*" onChange={e=>pick(e.target.files?.[0])}/></label>
        </div>}

        {active==='canvas'&&<div className="panel">
          <h3>Canvas 3:4</h3>
          <div className="seg"><button className={fit==='cover'?'on':''} onClick={()=>setFit('cover')}>Fill / Crop</button><button className={fit==='contain'?'on':''} onClick={()=>setFit('contain')}>Fit</button></div>
          {fit==='cover'&&<>
            <p className="hint">Preview ichidagi videoni sichqoncha bilan torting.</p>
            <label>Gorizontal <input type="range" min="0" max="100" value={focusX} onChange={e=>setFocusX(+e.target.value)}/><b>{Math.round(focusX)}%</b></label>
            <label>Vertikal <input type="range" min="0" max="100" value={focusY} onChange={e=>setFocusY(+e.target.value)}/><b>{Math.round(focusY)}%</b></label>
            <button className="soft" onClick={()=>{setFocusX(50);setFocusY(50)}}>Markazga qaytarish</button>
          </>}
        </div>}

        {active==='trim'&&<div className="panel">
          <h3>Qirqish</h3>
          <label>Boshi <input type="range" min="0" max={Math.max(0,end-.1)} step=".1" value={start} onChange={e=>setStart(Math.min(+e.target.value,end-.1))}/><b>{start.toFixed(1)}s</b></label>
          <label>Oxiri <input type="range" min={Math.min(duration,start+.1)} max={duration} step=".1" value={end} onChange={e=>setEnd(Math.max(+e.target.value,start+.1))}/><b>{end.toFixed(1)}s</b></label>
          <div className="bigMetric">{outputDuration.toFixed(1)} <small>sekund chiqish</small></div>
        </div>}

        {active==='speed'&&<div className="panel">
          <h3>Tezlik</h3>
          <div className="speedGrid">{[1,1.25,1.5,1.75,2,2.5,3].map(v=><button key={v} className={speed===v?'on':''} onClick={()=>setSpeed(v)}>{v}×</button>)}</div>
          <p className="hint">Tezlik oshsa video qisqaradi va 3 MB ichida sifat uchun ko‘proq bitrate qoladi.</p>
        </div>}

        {active==='audio'&&<div className="panel">
          <h3>Ovoz</h3>
          <div className="seg"><button className={audio==='keep'?'on':''} onClick={()=>setAudio('keep')}>🔊 Ovozli</button><button className={audio==='mute'?'on':''} onClick={()=>setAudio('mute')}>🔇 Ovozsiz</button></div>
          {audio==='keep'&&<label>Volume <input type="range" min="0" max="150" value={volume} onChange={e=>setVolume(+e.target.value)}/><b>{volume}%</b></label>}
        </div>}

        {active==='adjust'&&<div className="panel">
          <h3>Rang / Tiniqlik</h3>
          <label>Yorug‘lik <input type="range" min="70" max="130" value={brightness} onChange={e=>setBrightness(+e.target.value)}/><b>{brightness}%</b></label>
          <label>Kontrast <input type="range" min="70" max="140" value={contrast} onChange={e=>setContrast(+e.target.value)}/><b>{contrast}%</b></label>
          <label>Rang <input type="range" min="60" max="150" value={saturation} onChange={e=>setSaturation(+e.target.value)}/><b>{saturation}%</b></label>
          <label>Tiniqlik <input type="range" min="0" max="100" value={sharpness} onChange={e=>setSharpness(+e.target.value)}/><b>{sharpness}%</b></label>
          <button className="soft" onClick={()=>{setBrightness(100);setContrast(100);setSaturation(100);setSharpness(28)}}>Standartga qaytarish</button>
        </div>}

        {active==='export'&&<div className="panel">
          <h3>Export</h3>
          <div className="exportPreset"><div><b>UZUM SELLER</b><span>1080×1440 · MP4 · H.264</span></div><strong>✓</strong></div>
          <div className="seg"><button className={quality==='fast'?'on':''} onClick={()=>setQuality('fast')}>⚡ Tez</button><button className={quality==='quality'?'on':''} onClick={()=>setQuality('quality')}>✨ Sifat</button></div>
          <div className="facts"><span>FPS <b>{fps}</b></span><span>Video <b>~{estimatedVideoK}k</b></span><span>Audio <b>{audio==='mute'?'Off':'32k'}</b></span><span>Limit <b>3.00 MB</b></span><span>Watermark <b>AUTO · xira</b></span></div>
        </div>}

        <div className="exportDock">
          {validation&&<div className={'check '+(validation.sizeOK&&validation.dimensionsOK&&validation.ratioOK?'ok':'bad')}><strong>{validation.sizeOK&&validation.dimensionsOK&&validation.ratioOK?'✓ UZUM CHECK':'! CHECK'}</strong><span>{validation.width}×{validation.height} · {fmtSize(validation.size)}</span><small>{validation.sizeOK?'✓ ≤3 MB':'✕ >3 MB'} · {validation.ratioOK?'✓ 3:4':'✕ ratio'}</small></div>}
          {message&&<div className={'status '+status}>{message}</div>}
          <button className="exportBtn" disabled={status==='processing'} onClick={exportVideo}>{status==='processing'?'TAYYORLANMOQDA '+progress+'%':'UZUM UCHUN EXPORT'}</button>
          {status==='processing'&&<div className="progress"><i style={{width:progress+'%'}}/></div>}
          {outUrl&&<a className="download" href={outUrl} download="uzum-video-1080x1440.mp4">↓ YUKLAB OLISH · {fmtSize(outSize)}</a>}
          <small className="shortcut">Ctrl + Enter = Export</small>
        </div>
      </aside>
    </div>
  </main>;
}
