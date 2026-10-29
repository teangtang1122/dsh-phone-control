// Fast evidence snapshots deliberately avoid UIAutomator/OCR: either can wait
// for the UI to become idle and miss a short upload/progress overlay.
export async function capturePhoneActionFeedback({ capture, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), actionCompletedAt,
  maxBytes = 8 * 1024 * 1024, maxFrameBytes = 4 * 1024 * 1024 } = {}) {
  const frames = [];
  let bytes = 0, status = 'captured', reason;
  for (let index = 0; index < 2; index++) {
    try {
      if (index) await wait(400);
      const frame = await capture();
      if (!frame || !Buffer.isBuffer(frame.png)) throw new Error('invalid capture');
      if (frame.png.length > maxFrameBytes || bytes + frame.png.length > maxBytes) {
        status = frames.length ? 'partial' : 'unavailable'; reason = 'size_limit'; break;
      }
      bytes += frame.png.length;
      const capturedAt = now();
      frames.push({ index: index + 1, capturedAt,
        afterActionMs: Math.max(0, capturedAt - actionCompletedAt),
        width: frame.width, height: frame.height,
        image: { mimeType: 'image/png', data: frame.png.toString('base64') } });
    } catch (error) {
      // Do not label an already-issued input as failed merely because evidence
      // collection failed; that could cause a duplicate submit on retry.
      status = frames.length ? 'partial' : 'unavailable';
      reason = error?.code === 'screen_protected' ? 'screen_protected' : 'capture_failed';
      break;
    }
  }
  return { status, ...(reason ? { reason } : {}), frames,
    hint: '这些是点击后按时间顺序采集的画面，仅用于核验，不提供下一次操作的observationId。可能漏掉短暂进度；未看见进度不代表没发生。页面跳转不证明点中了目标或保存成功；检查明确成功提示或最终内容更新，未确认时不要重复提交。下一步操作前重新observe。' };
}
