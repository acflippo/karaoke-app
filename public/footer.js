// Footer with Support and Privacy Policy links, shared by the login page, the admin console,
// and the support and privacy pages themselves.
// Not shown on the display screen (?view=display), which is meant for the big monitor.
document.addEventListener('DOMContentLoaded', () => {
  if (new URLSearchParams(window.location.search).get('view') === 'display') return;

  const footer = document.createElement('footer');
  footer.className = 'w-full py-4 text-center text-sm text-slate-500';
  footer.innerHTML = `
    <a href="/support.html" class="hover:text-slate-300 underline underline-offset-2">Support</a>
    <span class="mx-3" aria-hidden="true">•</span>
    <a href="/privacy.html" class="hover:text-slate-300 underline underline-offset-2">Privacy Policy</a>
  `;
  document.body.append(footer);
});
