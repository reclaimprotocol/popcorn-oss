const params = new URLSearchParams(window.location.search);
const error = params.get('error');
if (error) {
  const errorEl = document.getElementById('error');
  errorEl.textContent = error;
  errorEl.style.display = 'block';
}

fetch('/admin/auth/config')
  .then((res) => res.json())
  .then((config) => {
    document.getElementById('password-form').hidden = !config.password;
    document.getElementById('google-auth').hidden = !config.google;
    document.getElementById('oidc-auth').hidden = !config.oidc;
    document.getElementById('empty').hidden = config.password || config.google || config.oidc;
  })
  .catch(() => {
    const errorEl = document.getElementById('error');
    errorEl.textContent = 'Unable to load administrator sign-in options.';
    errorEl.style.display = 'block';
  });
