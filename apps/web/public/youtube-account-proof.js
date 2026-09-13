// Fixed non-secret markers in disposable proof profiles only.
const allowed = value => /^(ACCOUNT_A|ACCOUNT_B)$/.test(value ?? '') ? value : 'EMPTY';
const render = () => {
  const cookie = document.cookie.split('; ').find(value => value.startsWith('space_youtube_account_proof='))?.split('=')[1];
  document.querySelector('#result').textContent = 'STORAGE_' + allowed(localStorage.getItem('space_youtube_account_proof')) + ' COOKIE_' + allowed(cookie);
};
document.querySelector('#marker').addEventListener('input', event => {
  const value = allowed(event.target.value);
  if (value === 'EMPTY') return;
  localStorage.setItem('space_youtube_account_proof', value);
  document.cookie = 'space_youtube_account_proof=' + value + '; Path=/; SameSite=Lax; Max-Age=600';
  render();
});
render();
