(() => {
  const key = 'port-manager-analytics-consent';
  const config = window.PORT_MANAGER_SITE || {};
  const consent = localStorage.getItem(key);
  const banner = document.querySelector('#consent');
  const dialog = document.querySelector('#download-dialog');

  function track(name) {
    if (localStorage.getItem(key) !== 'granted' || typeof window.gtag !== 'function') return;
    window.gtag('event', name, { locale: config.locale });
  }

  function loadAnalytics() {
    if (!config.gaId || document.querySelector('[data-ga4]')) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.gaId)}`;
    script.dataset.ga4 = 'true';
    script.onload = () => {
      window.dataLayer = window.dataLayer || [];
      window.gtag = function gtag() { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      window.gtag('config', config.gaId, { anonymize_ip: true });
    };
    document.head.append(script);
  }

  if (consent === 'granted') loadAnalytics();
  if (!consent && banner) banner.hidden = false;

  document.querySelectorAll('[data-consent]').forEach((button) => button.addEventListener('click', () => {
    localStorage.setItem(key, button.dataset.consent);
    banner.hidden = true;
    if (button.dataset.consent === 'granted') loadAnalytics();
  }));

  document.querySelectorAll('[data-download-open]').forEach((button) => button.addEventListener('click', () => {
    dialog?.showModal();
    track('download_selector_open');
  }));
  document.querySelector('[data-dialog-close]')?.addEventListener('click', () => dialog?.close());
  document.querySelectorAll('[data-track]').forEach((link) => link.addEventListener('click', () => track(link.dataset.track)));
  document.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
    const code = event.currentTarget.parentElement.querySelector('code').textContent;
    await navigator.clipboard.writeText(code);
    event.currentTarget.textContent = config.locale === 'he' ? 'הועתק' : 'Copied';
    track('mcp_config_copy');
  });
})();
