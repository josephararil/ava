
  const slides=[...document.querySelectorAll('.slide')];
  const dotsWrap=document.getElementById('dots');
  const progress=document.getElementById('progress');
  const curEl=document.getElementById('cur');
  const totEl=document.getElementById('tot');
  let i=0;
  if(totEl) totEl.textContent=String(slides.length-1).padStart(2,'0');
  slides.forEach((_,n)=>{
    const b=document.createElement('button');
    b.className='dot'+(n===0?' on':''); b.setAttribute('aria-label','slide '+(n+1));
    b.onclick=(e)=>{e.stopPropagation();go(n);}; dotsWrap.appendChild(b);
  });
  const dots=[...dotsWrap.children];
  function go(n){
    n=Math.max(0,Math.min(slides.length-1,n));
    slides[i].classList.remove('active'); dots[i].classList.remove('on');
    i=n;
    slides[i].classList.add('active'); dots[i].classList.add('on');
    progress.style.width=(i/(slides.length-1)*100)+'%';
    curEl.textContent=String(i).padStart(2,'0');
    document.body.classList.toggle('on-cover', i===0);
  }
  function next(){go(i+1)} function prev(){go(i-1)}
  addEventListener('keydown',e=>{
    if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){e.preventDefault();next();}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();prev();}
    else if(e.key==='Home'){go(0)} else if(e.key==='End'){go(slides.length-1)}
  });
  addEventListener('click',e=>{ if(e.target.closest('.dots')) return; (e.clientX > innerWidth*0.5) ? next() : prev(); });
  progress.style.width='0%';
  document.body.classList.add('on-cover');
