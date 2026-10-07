import { RadioProfiles, mhzToHz, formatMHz, receivedFrequency } from './radio-profiles.js';
const $ = id => document.getElementById(id);

export function initFrequencyPanel({ store, catalog, position, unavailable, epoch }) {
  const book = new RadioProfiles(store);
  let editing = null, target = null;
  function current() { return book.current(catalog()); }
  function render() {
    const choice = current(), point = position();
    const result = choice && receivedFrequency(choice.tunedHz, point);
    $('receiveFrequency').textContent = result ? formatMHz(result.receivedHz) : '—';
    $('nominalFrequency').textContent = choice ? `标称 ${formatMHz(choice.tunedHz)} MHz` : '请在设置中新增下行频率';
    $('frequencyMode').textContent = choice?.profile.mode || 'RX';
    $('dopplerShift').textContent = result ? `${result.shiftHz >= 0 ? '+' : '−'}${Math.abs(result.shiftHz / 1000).toFixed(3)} kHz` : '频移 —';
    const old = Number.isFinite(epoch()) && Date.now() - epoch() > 72 * 3600000;
    $('frequencyStatus').textContent = !choice ? '此卫星尚未设置下行频率' : !result ? unavailable()
      : `${point.elevation < 0 ? '地平线下 · ' : ''}${point.rangeRateKmS < -.001 ? '接近' : point.rangeRateKmS > .001 ? '远离' : '距离变化接近零'}${old ? ' · 星历较旧，请更新' : ''}`;
    $('frequencyStatus').classList.toggle('is-warning', old || !result);
  }
  function choices() {
    if (target !== catalog()) { target = catalog(); editing = null; $('frequencyForm').hidden = true; $('frequencyError').textContent = ''; }
    const select = $('frequencySelect'); select.replaceChildren();
    for (const profile of book.list(catalog())) select.add(new Option(profile.name, profile.id));
    const choice = current();
    if (!choice) select.add(new Option('设置下行频率…', ''));
    select.value = choice?.profile.id || '';
    $('frequencyEdit').disabled = $('frequencyDelete').disabled = !choice || !!choice.profile.builtin;
    $('bandTuneForm').hidden = !choice || choice.profile.lowHz === choice.profile.highHz;
    $('bandTuneMHz').value = choice ? formatMHz(choice.tunedHz) : '';
    const source = $('frequencySource'); source.replaceChildren();
    if (choice) {
      const profile = choice.profile;
      source.append(`${formatMHz(profile.lowHz)}${profile.lowHz === profile.highHz ? '' : `～${formatMHz(profile.highHz)}`} MHz · ${profile.note || '自定义下行频率'}`);
      if (profile.source) {
        const link = document.createElement('a'); link.href = profile.source; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = ` ARISS · 核对 ${profile.checkedAt}`; source.append(link);
      }
    }
    render();
  }
  async function action(fn) {
    try { await fn(); $('frequencyError').textContent = ''; choices(); }
    catch (error) { $('frequencyError').textContent = error.message; }
  }
  function edit(profile = null) {
    editing = profile?.id || null;
    $('frequencyName').value = profile?.name || '';
    $('frequencyModeInput').value = profile?.mode || 'FM';
    $('frequencyKind').value = profile && profile.lowHz !== profile.highHz ? 'band' : 'fixed';
    $('frequencyLow').value = profile ? formatMHz(profile.lowHz) : '';
    $('frequencyHigh').value = profile ? formatMHz(profile.highHz) : '';
    kind(); $('frequencyForm').hidden = false; $('frequencyName').focus();
  }
  function kind() {
    const band = $('frequencyKind').value === 'band';
    $('frequencyHighField').hidden = !band; $('frequencyHigh').required = band;
    $('frequencyLowLabel').textContent = band ? '下限 MHz' : '下行频率 MHz';
  }
  $('frequencySelect').addEventListener('change', () => {
    if (!$('frequencySelect').value) return;
    $('frequencyForm').hidden = true; editing = null;
    void action(() => book.select(catalog(), $('frequencySelect').value));
  });
  $('bandTuneForm').addEventListener('submit', event => { event.preventDefault(); void action(() => book.select(catalog(), current().profile.id, mhzToHz($('bandTuneMHz').value))); });
  $('frequencyNew').addEventListener('click', () => edit());
  $('frequencyEdit').addEventListener('click', () => edit(current()?.profile));
  $('frequencyDelete').addEventListener('click', () => void action(async () => {
    await book.remove(catalog(), current().profile.id); editing = null; $('frequencyForm').hidden = true;
  }));
  $('frequencyKind').addEventListener('change', kind);
  $('frequencyForm').addEventListener('submit', event => {
    event.preventDefault();
    void action(async () => {
      const lowHz = mhzToHz($('frequencyLow').value);
      await book.save(catalog(), { id: editing, name: $('frequencyName').value, mode: $('frequencyModeInput').value,
        lowHz, highHz: $('frequencyKind').value === 'band' ? mhzToHz($('frequencyHigh').value) : lowHz });
      editing = null; $('frequencyForm').hidden = true;
    });
  });
  return { ready: book.load().then(choices), render, choices };
}
