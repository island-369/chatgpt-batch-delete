const path=require('path');const puppeteer=require('puppeteer-core');
(async()=>{
  const b=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new'});
  const p=await b.newPage();
  await p.setViewport({width:760,height:330,deviceScaleFactor:2});
  await p.goto('file://'+path.resolve(__dirname,'zoom.html').replace(/ /g,'%20'),{waitUntil:'load'});
  await new Promise(r=>setTimeout(r,300));
  await p.screenshot({path:path.resolve(__dirname,'shots/图标放大对比.png')});
  await b.close();console.log('ok');
})();
