'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const MAX_BYTES = 3 * 1024 * 1024;
// 3 MB limitga bir martada sig‘ish uchun xavfsiz zaxira qoldiramiz.
const TARGET_BYTES = Math.floor(2.82 * 1024 * 1024);
const GOOD_VIDEO_K = 900;
const MIN_VIDEO_K = 320;
const AUDIO_K = 64;

const fmtTime = (s=0) => {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
};
const fmtSize = (b=0) => b < 1024*1024 ? `${Math.round(b/1024)} KB` : `${(b/1024/1024).toFixed(2)} MB`;

export default function Home() {
  const [file,setFile] = useState(null);
  const [src,setSrc] = useState('');
  const [duration,setDuration] = useState(0);
  const [start,setStart] = useState(0);
  const [end,setEnd] = useState(0);
  const [cropMode,setCropMode] = useState('cover');
  const [focus,setFocus] = useState('center');
  const [audio,setAudio] = useState('keep');
  const [volume,setVolume] = useState(100);
  const [speed,setSpeed] = useState(1);
  const [watermark,setWatermark] = useState('');
  const [wmPos,setWmPos] = useState('br');
  const [opacity,setOpacity] = useState(70);
  const [exportMode,setExportMode] = useState('3mb');
  const [progress,setProgress] = useState(0);
  const [status,setStatus] = useState('idle');
  const [message,setMessage] = useState('');
  const [outUrl,setOutUrl] = useState('');
  const [outSize,setOutSize] = useState(0);
  const ffmpegRef = useRef(null);
  const enginePromiseRef = useRef(null);
  const engineModeRef = useRef('single');

  const clipDuration = useMemo(()=>Math.max(0.1,end-start),[start,end]);
  const outputDuration = useMemo(()=>Math.max(0.1,clipDuration/speed),[clipDuration,speed]);
  const maxClearSeconds = useMemo(()=>{
    const audioK=audio==='mute'?0:AUDIO_K;
    return Math.max(1,Math.floor((TARGET_BYTES*8/1000)/(GOOD_VIDEO_K+audioK+24)));
  },[audio]);
  const recommendedSpeed = useMemo(()=>{
    const choices=[1,1.25,1.5,1.75,2,2.5,3];
    const need=clipDuration/maxClearSeconds;
    return choices.find(v=>v>=need) || 3;
  },[clipDuration,maxClearSeconds]);

  useEffect(()=>()=> {
    if(src) URL.revokeObjectURL(src);
    if(outUrl) URL.revokeObjectURL(outUrl);
  },[src,outUrl]);

  function pick(f){
    if(!f){
      setFile(null);
      if(src) URL.revokeObjectURL(src);
      if(outUrl) URL.revokeObjectURL(outUrl);
      setSrc('');
      setOutUrl('');
      setOutSize(0);
      setStatus('idle');
      setMessage('');
      setProgress(0);
      return;
    }
    if(!f.type.startsWith('video/')) return setMessage('Video fayl tanlang.');
    if(src) URL.revokeObjectURL(src);
    if(outUrl) URL.revokeObjectURL(outUrl);
    setFile(f);
    setSrc(URL.createObjectURL(f));
    setOutUrl('');
    setOutSize(0);
    setStatus('idle');
    setMessage('Video tayyor. Eksport sozlamalarini tanlang.');
    setProgress(0);
  }

  async function loadEngine(silent=false){
    if(ffmpegRef.current) return ffmpegRef.current;
    if(enginePromiseRef.current) return enginePromiseRef.current;
    if(!silent) setMessage('Video dvigateli yuklanmoqda...');

    enginePromiseRef.current=(async()=>{
      const makeFFmpeg=()=>{
        const ffmpeg=new FFmpeg();
        ffmpeg.on('progress',({progress:p})=>{
          const pct=Math.max(1,Math.round((p||0)*100));
          if(pct>=98){
            setProgress(98);
            setMessage('MP4 fayl yakunlanmoqda...');
          }else{
            setProgress(Math.min(97,pct));
          }
        });
        return ffmpeg;
      };

      const canMulti = typeof crossOriginIsolated !== 'undefined'
        && crossOriginIsolated
        && typeof navigator !== 'undefined'
        && (navigator.hardwareConcurrency || 1) >= 4;

      if(canMulti){
        try{
          const ffmpeg=makeFFmpeg();
          const base='https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/umd';
          await ffmpeg.load({
            coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,'text/javascript'),
            wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`,'application/wasm'),
            workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`,'text/javascript')
          });
          engineModeRef.current='multi';
          ffmpegRef.current=ffmpeg;
          return ffmpeg;
        }catch(err){
          console.warn('Multi-thread FFmpeg ishlamadi, single-threadga o‘tiladi',err);
        }
      }

      const ffmpeg=makeFFmpeg();
      const base='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`,'application/wasm')
      });
      engineModeRef.current='single';
      ffmpegRef.current=ffmpeg;
      return ffmpeg;
    })();

    try{
      return await enginePromiseRef.current;
    } finally {
      enginePromiseRef.current=null;
    }
  }

  function overlayPos(){
    const p=exportMode==='4k'?64:32;
    return {
      tl:p+':'+p, tr:'W-w-'+p+':'+p, bl:p+':H-h-'+p,
      br:'W-w-'+p+':H-h-'+p, c:'(W-w)/2:(H-h)/2'
    }[wmPos] || ('W-w-'+p+':H-h-'+p);
  }

  function baseFilter(){
    const is4k=exportMode==='4k';
    const w=is4k?2160:1080;
    const h=is4k?2880:1440;
    const fps=is4k?30:24;
    const sharp=is4k?'unsharp=5:5:0.55:3:3:0.25':'unsharp=5:5:0.35:3:3:0.15';
    const speedFilter=speed===1?'':',setpts=PTS/'+speed;

    if(cropMode==='fit'){
      return 'scale='+w+':'+h+':force_original_aspect_ratio=decrease:flags=lanczos,pad='+w+':'+h+':(ow-iw)/2:(oh-ih)/2:black,'+sharp+',fps='+fps+speedFilter;
    }
    const pos={
      center:'(iw-'+w+')/2:(ih-'+h+')/2',
      top:'(iw-'+w+')/2:0',
      bottom:'(iw-'+w+')/2:ih-'+h,
      left:'0:(ih-'+h+')/2',
      right:'iw-'+w+':(ih-'+h+')/2'
    }[focus] || ('(iw-'+w+')/2:(ih-'+h+')/2');

    return 'scale='+w+':'+h+':force_original_aspect_ratio=increase:flags=lanczos,crop='+w+':'+h+':'+pos+','+sharp+',fps='+fps+speedFilter;
  }

  async function makeWatermark(ffmpeg){
    if(!watermark.trim()) return false;
    const c=document.createElement('canvas');
    const x=c.getContext('2d');
    const fs=exportMode==='4k'?96:48;
    x.font=`800 ${fs}px Arial`;
    const pad=exportMode==='4k'?96:48;
    c.width=Math.max(exportMode==='4k'?360:180,Math.ceil(x.measureText(watermark.trim()).width+pad));
    c.height=exportMode==='4k'?176:88;
    x.font=`800 ${fs}px Arial`;
    x.textAlign='center';
    x.textBaseline='middle';
    x.globalAlpha=opacity/100;
    x.lineWidth=7;
    x.strokeStyle='rgba(0,0,0,.45)';
    x.strokeText(watermark.trim(),c.width/2,c.height/2);
    x.fillStyle='#fff';
    x.fillText(watermark.trim(),c.width/2,c.height/2);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    await ffmpeg.writeFile('wm.png',new Uint8Array(await blob.arrayBuffer()));
    return true;
  }

  function audioTempoFilter(v){
    if(v<=2) return 'atempo='+v;
    if(v<=4) return 'atempo=2,atempo='+(v/2);
    return 'atempo=2,atempo=2,atempo='+(v/4);
  }

  async function encode(ffmpeg,inputName,videoK,attempt,hasWM){
    const out='out-'+attempt+'.mp4';
    const args=['-ss',start.toFixed(3),'-i',inputName];
    if(hasWM) args.push('-loop','1','-i','wm.png');
    args.push('-t',clipDuration.toFixed(3));

    if(hasWM){
      args.push('-filter_complex','[0:v]'+baseFilter()+'[base];[base][1:v]overlay='+overlayPos()+'[v]','-map','[v]','-map','0:a?');
    }else{
      args.push('-vf',baseFilter());
    }

    if(exportMode==='4k'){
      args.push('-c:v','libx264','-preset','veryfast','-profile:v','high','-level','5.1','-crf','19','-threads','4','-pix_fmt','yuv420p','-movflags','+faststart');
    }else{
      const vk=Math.max(MIN_VIDEO_K,Math.floor(videoK));
      args.push('-c:v','libx264','-preset','veryfast','-profile:v','high','-level','4.1','-threads','4','-pix_fmt','yuv420p','-b:v',vk+'k','-maxrate',Math.floor(vk*1.04)+'k','-bufsize',Math.floor(vk*2)+'k','-movflags','+faststart');
    }

    if(audio==='mute'){
      args.push('-an');
    }else{
      args.push('-c:a','aac','-b:a',(exportMode==='4k'?128:AUDIO_K)+'k');
      const af=[];
      if(speed!==1) af.push(audioTempoFilter(speed));
      if(volume!==100) af.push('volume='+(volume/100).toFixed(2));
      if(af.length) args.push('-af',af.join(','));
    }

    args.push('-y',out);
    await ffmpeg.exec(args);
    const data=await ffmpeg.readFile(out);
    try{await ffmpeg.deleteFile(out);}catch{}
    return new Uint8Array(data);
  }

  async function exportVideo(){
    if(!file) return;

    setStatus('processing');
    setProgress(1);
    setMessage(exportMode==='4k'?'4K maksimal sifat tayyorlanmoqda...':'Tiniq 3 MB eksport tayyorlanmoqda...');
    setOutUrl('');
    setOutSize(0);

    try{
      const ffmpeg=await loadEngine();
      const ext=(file.name.split('.').pop()||'mp4').replace(/[^a-z0-9]/gi,'').toLowerCase();
      const inputName='input.'+(ext||'mp4');
      await ffmpeg.writeFile(inputName,await fetchFile(file));

      const totalK=Math.floor((TARGET_BYTES*8)/outputDuration/1000);
      const audioK=audio==='mute'?0:AUDIO_K;
      let videoK=Math.max(MIN_VIDEO_K,totalK-audioK-24);
      const hasWM=await makeWatermark(ffmpeg);

      setMessage(exportMode==='4k' ? '4K 2160×2880 kodlanmoqda — bu rejim sekinroq...' : (engineModeRef.current==='multi'?'Ko‘p yadroli tiniq siqish...':'Tiniq siqish...'));
      let result=await encode(ffmpeg,inputName,videoK,1,hasWM);

      if(exportMode==='3mb' && result.byteLength>MAX_BYTES){
        setProgress(1);
        setMessage('3 MB limitga aniq moslayapman...');
        videoK=Math.max(MIN_VIDEO_K,Math.floor(videoK*(TARGET_BYTES/result.byteLength)*0.90));
        result=await encode(ffmpeg,inputName,videoK,2,hasWM);
      }

      try{await ffmpeg.deleteFile(inputName);}catch{}
      if(hasWM){try{await ffmpeg.deleteFile('wm.png');}catch{}}

      const blob=new Blob([result],{type:'video/mp4'});
      const u=URL.createObjectURL(blob);
      setOutUrl(u);
      setOutSize(blob.size);
      setProgress(100);

      if(exportMode==='4k'){
        setStatus('done');
        setMessage('4K MAX sifat tayyor — 2160×2880.');
      }else if(blob.size<=MAX_BYTES){
        setStatus('done');
        setMessage('Tayyor — 1080×1440, tiniq va 3 MB limit ichida.');
      }else{
        setStatus('warning');
        setMessage('3 MB limitda sifatni saqlab bo‘lmadi. Videoni yana biroz qisqartiring.');
      }
    }catch(e){
      console.error(e);
      setStatus('error');
      setMessage(exportMode==='4k' ? '4K eksport uchun brauzer xotirasi yetmadi yoki video juda uzun. Qisqaroq video bilan urinib ko‘ring.' : 'Eksportda xato yuz berdi. Chrome yoki Edge’da qayta urinib ko‘ring.');
    }
  }

  if(!file){
    return <main className="shell">
      <header><div className="logo">VIDEO<span>3MB</span></div><div className="chip">1080×1440 · 3 MB + 4K</div></header>
      <section className="hero">
        <div className="kicker">MARKETPLACE VIDEO TOOL</div>
        <h1>Videoni <span>3 MB</span> gacha tayyorlang</h1>
        <p>Qirqish, 3:4 crop, 1080×1440, watermark, ovozli/ovozsiz va avtomatik siqish — bitta joyda.</p>
      </section>
      <label className="drop">
        <div className="uploadIcon">↑</div>
        <h2>Video yuklang</h2>
        <p>MP4, MOV yoki WebM</p>
        <strong>VIDEO TANLASH</strong>
        <input type="file" accept="video/*" onChange={e=>pick(e.target.files?.[0])}/>
      </label>
      <p className="privacy">Video brauzeringizda qayta ishlanadi.</p>
    </main>;
  }

  return <main className="shell">
    <header><div className="logo">VIDEO<span>3MB</span></div><button className="linkBtn" onClick={()=>pick(null)}>Yangi video</button></header>
    <section className="work">
      <div className="preview card">
        <video src={src} controls onLoadedMetadata={e=>{const d=e.currentTarget.duration||0;setDuration(d);setStart(0);setEnd(d)}} />
        {watermark && <div className={`wm ${wmPos}`} style={{opacity:opacity/100}}>{watermark}</div>}
        <div className="meta"><span>{file.name}</span><span>{fmtSize(file.size)}</span><span>{fmtTime(duration)}</span></div>
      </div>

      <div className="controls card">
        <div className="block">
          <h3>1. Qirqish</h3>
          <label>Boshi <input type="range" min="0" max={Math.max(0,end-.1)} step=".1" value={start} onChange={e=>setStart(Math.min(+e.target.value,end-.1))}/><b>{fmtTime(start)}</b></label>
          <label>Oxiri <input type="range" min={Math.min(duration,start+.1)} max={duration} step=".1" value={end} onChange={e=>setEnd(Math.max(+e.target.value,start+.1))}/><b>{fmtTime(end)}</b></label>
        </div>

        <div className="block">
          <h3>2. Format va crop</h3>
          <div className="seg">
            <button className={exportMode==='3mb'?'on':''} onClick={()=>setExportMode('3mb')}>1080×1440 · 3 MB</button>
            <button className={exportMode==='4k'?'on':''} onClick={()=>setExportMode('4k')}>4K · 2160×2880</button>
          </div>
          <div className="seg">
            <button className={cropMode==='cover'?'on':''} onClick={()=>setCropMode('cover')}>3:4 Crop</button>
            <button className={cropMode==='fit'?'on':''} onClick={()=>setCropMode('fit')}>To‘liq sig‘dirish</button>
          </div>
          {cropMode==='cover' && <select value={focus} onChange={e=>setFocus(e.target.value)}>
            <option value="center">Markaz</option><option value="top">Tepa</option><option value="bottom">Past</option><option value="left">Chap</option><option value="right">O‘ng</option>
          </select>}
        </div>

        <div className="block">
          <h3>3. Tezlik</h3>
          <div className="seg">
            {[1,1.25,1.5,1.75,2,2.5,3].map(v=><button key={v} className={speed===v?'on':''} onClick={()=>setSpeed(v)}>{v}×</button>)}
          </div>
          <div className="msg">
            Chiqish: {Math.ceil(outputDuration)} sek. · Tavsiya: <b>{recommendedSpeed}×</b>
            {recommendedSpeed===3 && outputDuration>maxClearSeconds ? ' + kerak bo‘lsa qirqish' : ''}
          </div>
        </div>

        <div className="block">
          <h3>4. Ovoz</h3>
          <div className="seg">
            <button className={audio==='keep'?'on':''} onClick={()=>setAudio('keep')}>🔊 Ovozli</button>
            <button className={audio==='mute'?'on':''} onClick={()=>setAudio('mute')}>🔇 Ovozsiz</button>
          </div>
          {audio==='keep' && <label>Ovoz <input type="range" min="0" max="150" value={volume} onChange={e=>setVolume(+e.target.value)}/><b>{volume}%</b></label>}
        </div>

        <div className="block">
          <h3>5. Suv belgisi</h3>
          <input className="text" placeholder="Masalan: Nur Baraka" value={watermark} onChange={e=>setWatermark(e.target.value)} />
          <div className="row">
            <select value={wmPos} onChange={e=>setWmPos(e.target.value)}>
              <option value="br">Past o‘ng</option><option value="bl">Past chap</option><option value="tr">Tepa o‘ng</option><option value="tl">Tepa chap</option><option value="c">Markaz</option>
            </select>
            <label className="opacity">Shaffoflik <input type="range" min="15" max="100" value={opacity} onChange={e=>setOpacity(+e.target.value)}/><b>{opacity}%</b></label>
          </div>
        </div>

        <div className="target">
          <div><small>FORMAT</small><b>{exportMode==='4k'?'2160×2880 · 4K':'1080×1440'}</b></div>
          <div><small>{exportMode==='4k'?'SIFAT':'MAX HAJM'}</small><b>{exportMode==='4k'?'MAX · CRF 19':'3.00 MB'}</b></div>
          <div><small>TEZLIK</small><b>{speed}×</b></div>
        </div>
        {exportMode==='3mb' && outputDuration>maxClearSeconds && <div className="msg warning">3 MB uchun tavsiya: {recommendedSpeed}×. Hozirgi chiqish: {Math.ceil(outputDuration)} sek. Eksport baribir ishlaydi.</div>}
        {exportMode==='3mb' && Math.floor((TARGET_BYTES*8)/outputDuration/1000)-(audio==='mute'?0:AUDIO_K)-24 < GOOD_VIDEO_K && <div className="msg warning">Video uzunligi sabab sifat pasayishi mumkin. 2×–3× tezlik yoki qirqish tiniqlikni oshiradi.</div>}
        {exportMode==='4k' && <div className="msg">4K rejim fayl hajmini cheklamaydi. Sifat maksimal, eksport 1080 rejimdan sekinroq.</div>}
        <button className="export" disabled={status==='processing'} onClick={exportVideo}>{status==='processing'?('TAYYORLANMOQDA '+progress+'%'):(exportMode==='4k'?'4K MAX SIFATDA TAYYORLASH':'3 MB TINIQ VIDEO TAYYORLASH')}</button>
        {status==='processing' && <div className="bar"><i style={{width:`${progress}%`}}/></div>}
        {message && <div className={`msg ${status}`}>{message}</div>}
        {outUrl && <div className="result"><div><b>Video tayyor</b><span>{fmtSize(outSize)} · {exportMode==='4k'?'4K 2160×2880':'1080×1440'} · {speed}× · {audio==='mute'?'ovozsiz':'ovozli'}</span></div><a href={outUrl} download={exportMode==='4k'?'video-4k-2160x2880.mp4':'video-1080x1440-3mb.mp4'}>YUKLAB OLISH</a></div>}
      </div>
    </section>
  </main>;
}