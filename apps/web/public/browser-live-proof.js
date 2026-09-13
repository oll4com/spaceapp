// Fixed, credential-free acceptance page. Animation stops after 60 seconds.
document.body.style.cssText = 'margin:0;background:#101b26;color:#d9f6f0;font:20px system-ui';
const heading = document.createElement('h1');
heading.textContent = 'Shared browser · Live connection';
heading.style.cssText = 'position:absolute;left:40px;top:8px;font-size:24px';
document.body.append(heading);
const button = document.createElement('button');
button.textContent = 'Test shared input';
button.style.cssText = 'position:absolute;left:40px;top:80px;width:240px;height:80px;font:20px system-ui;background:#4ac6b2;border:0;border-radius:12px';
let audio;
button.onclick = () => {
  button.textContent = 'Input received'; console.info('SPACE_BROWSER_PROOF_INPUT');
  if (audio) return;
  audio = new AudioContext();
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0.015; tone.frequency.value = 220;
  tone.connect(gain).connect(audio.destination); tone.start();
  void audio.resume().then(() => console.info('SPACE_BROWSER_PROOF_AUDIO_RUNNING'));
  setTimeout(() => { tone.stop(); void audio.close(); }, 45000);
};
document.body.append(button);
const email = document.createElement('input');
email.type = 'email';
email.autocomplete = 'off';
email.placeholder = 'Test email input';
email.setAttribute('aria-label', 'Test email input');
email.style.cssText = 'position:absolute;left:320px;top:90px;width:min(400px,calc(100vw - 340px));height:50px;font:18px system-ui';
const expectedEmail = 'first.last+tag_test-1@example.com';
const keyboardSteps = [expectedEmail, expectedEmail + 'x', expectedEmail, expectedEmail.slice(1), expectedEmail, expectedEmail + '.', expectedEmail];
let keyboardStep = 0;
email.addEventListener('input', () => {
  if (email.value === 'scroll-typing-proof') console.info('SPACE_BROWSER_PROOF_SCROLL_TYPING');
  if (email.value === keyboardSteps[keyboardStep]) {
    keyboardStep++;
    // Only fixed success markers; never log arbitrary typed text.
    console.info('SPACE_BROWSER_PROOF_KEYBOARD_STEP_' + keyboardStep);
  }
});
document.body.append(email);
const login = document.createElement('form');
login.autocomplete = 'off';
const password = document.createElement('input');
password.type = 'password';
password.autocomplete = 'off';
password.placeholder = 'Test password';
password.setAttribute('aria-label', 'Test password');
password.style.cssText = 'position:absolute;left:40px;top:170px;width:280px;height:40px;font:18px system-ui';
const expectedPassword = 'Proof!Pass9@_-';
password.oninput = () => {
  if (password.value === expectedPassword && password.type === 'password') console.info('SPACE_BROWSER_PROOF_PASSWORD_MASKED');
};
const remember = document.createElement('input');
remember.type = 'checkbox';
remember.setAttribute('aria-label', 'Test checkbox');
remember.style.cssText = 'position:absolute;left:345px;top:180px;width:24px;height:24px';
remember.onchange = () => { if (remember.checked) console.info('SPACE_BROWSER_PROOF_CHECKBOX_CHECKED'); };
const submit = document.createElement('button');
submit.type = 'submit';
submit.textContent = 'Test login';
submit.style.cssText = 'position:absolute;left:390px;top:170px;width:100px;height:44px';
login.append(password, remember, submit);
login.onsubmit = (event) => {
  event.preventDefault();
  if (password.value === expectedPassword && email.value === expectedEmail && remember.checked) {
    console.info('SPACE_BROWSER_PROOF_PASSWORD_SUBMITTED');
    password.value = '';
    submit.textContent = 'Verified';
  }
};
document.body.append(login);
const canvas = document.createElement('canvas');
canvas.width = 1200; canvas.height = 500;
canvas.style.cssText = 'position:absolute;left:40px;top:250px;width:calc(100vw - 80px);max-width:1200px;height:auto';
document.body.append(canvas);
const ctx = canvas.getContext('2d');
const start = performance.now();
function draw(now) {
  const t = (now - start) / 1000;
  ctx.fillStyle = '#152a37'; ctx.fillRect(0, 0, 1200, 500);
  ctx.fillStyle = '#4ac6b2'; ctx.fillRect((t * 150) % 1080, 80, 120, 180);
  ctx.fillStyle = '#d9f6f0'; ctx.font = '28px system-ui'; ctx.fillText('Live frames · ' + t.toFixed(1) + ' s', 32, 340);
  if (t < 60) requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
console.info('SPACE_BROWSER_PROOF_READY');
fetch('/version').then(response => response.text()).then(() => console.info('SPACE_BROWSER_PROOF_NETWORK')).catch(() => {});

// Fixed scroll surface: enough content to validate distance in both directions.
const scrollBox = document.createElement('div');
scrollBox.style.cssText = 'position:absolute;left:40px;top:250px;width:calc(100vw - 80px);height:180px;overflow:auto;overscroll-behavior:contain;background:#17374b';
const scrollContent = document.createElement('div');
scrollContent.style.cssText = 'height:6000px;background:repeating-linear-gradient(#17374b 0px,#397b86 80px,#17374b 160px)';
scrollContent.textContent = 'Scroll responsiveness test';
scrollBox.append(scrollContent); document.body.append(scrollBox);
let scrolledDown = false;
scrollBox.addEventListener('scroll', () => {
  if (!scrolledDown && scrollBox.scrollTop >= 958) { scrolledDown = true; console.info('SPACE_BROWSER_PROOF_SCROLL_DOWN'); }
  if (scrolledDown && scrollBox.scrollTop <= 2) { scrolledDown = false; console.info('SPACE_BROWSER_PROOF_SCROLL_RETURN'); }
});
