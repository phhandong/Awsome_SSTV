// RFC 5545 iCalendar export. No calendar or tracking data is written here.
const calendarType = 'text/calendar;charset=utf-8';
const encoder = new TextEncoder();
const utc = time => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const text = value => String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');

// Fold at 75 UTF-8 octets, including the continuation space, without splitting characters.
function fold(line) {
  const lines = []; let part = '', bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) { lines.push(part); part = ' '; bytes = 1; }
    part += char; bytes += size;
  }
  lines.push(part);
  return lines.join('\r\n');
}

export function createPassCalendar({ satellite, observer, pass, now = Date.now() }) {
  if (!satellite || !observer || !pass || ![satellite.epoch, pass.rise, pass.set, pass.peak, pass.maxElevation, now].every(Number.isFinite)
    || pass.set <= pass.rise || pass.set <= now || pass.peak < pass.rise || pass.peak > pass.set) {
    throw new Error('过境时间无效或已结束，请等待预测更新');
  }
  if (![observer.latitude, observer.longitude, observer.altitude].every(Number.isFinite)) throw new Error('请先设置有效观测位置');
  const name = satellite.name || `NORAD ${satellite.catalogId}`;
  const location = `观测位置 ${observer.latitude.toFixed(5)}, ${observer.longitude.toFixed(5)} · 海拔 ${observer.altitude} m`;
  const notes = [
    `${name} · NORAD ${satellite.catalogId}`,
    `最高点（UTC）${new Date(pass.peak).toISOString()} · 最高仰角 ${pass.maxElevation.toFixed(1)}°`,
    `星历历元（UTC）${new Date(satellite.epoch).toISOString()}`,
    '时间由星历和观测位置预测；过境以几何地平线计算，不代表肉眼可见、无遮挡或正在发射 SSTV。',
    '此事件为导出时的预测快照；星历或位置变化后请重新核对并手动更新日历事件。'
  ];
  if (pass.ongoingStart) notes.push('预测起点已在地平线上方；事件开始时间为预测窗口起点，并非实际升起时间。');
  if (pass.ongoingEnd) notes.push('预测窗口内未落下；事件结束时间为预测窗口终点，并非实际落下时间。');
  // Identity includes the source, observer and peak minute; repeated exports share a UID.
  const identity = [satellite.id, observer.latitude, observer.longitude, observer.altitude, Math.floor(pass.peak / 60000)].join('|');
  const uid = `${Array.from(encoder.encode(identity), byte => byte.toString(16).padStart(2, '0')).join('')}@awsome-sstv`;
  const summary = `${name} 卫星过境`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Awesome SSTV//Satellite Pass//ZH', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utc(now)}`, `DTSTART:${utc(pass.rise)}`, `DTEND:${utc(pass.set)}`,
    `SUMMARY:${text(summary)}`, `LOCATION:${text(location)}`, `DESCRIPTION:${text(notes.join('\n'))}`, 'TRANSP:TRANSPARENT'];
  if (!pass.ongoingStart && pass.rise - 5 * 60000 > now) {
    lines.push('BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', `DESCRIPTION:${text(`${summary}将在 5 分钟后开始`)}`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return { content: lines.map(fold).join('\r\n') + '\r\n', title: summary,
    filename: `satellite-${String(satellite.catalogId).replace(/[^a-z0-9-]/gi, '') || 'pass'}-${utc(pass.rise)}.ics` };
}

function download(calendar) {
  const url = URL.createObjectURL(new Blob([calendar.content], { type: calendarType }));
  const link = document.createElement('a');
  link.href = url; link.download = calendar.filename;
  document.body.append(link); link.click(); link.remove();
  // Allow Safari enough time to consume the file before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function exportPassCalendar(calendar) {
  if (typeof File === 'function' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    try {
      const file = new File([calendar.content], calendar.filename, { type: calendarType });
      if (navigator.canShare({ files: [file] })) {
        // Called synchronously from the click handler to preserve user activation on iOS.
        await navigator.share({ files: [file], title: calendar.title });
        return 'shared';
      }
    } catch (error) {
      if (error.name === 'AbortError') return 'cancelled';
      // Unsupported file sharing or permission failures still allow a download.
    }
  }
  download(calendar);
  return 'downloaded';
}
