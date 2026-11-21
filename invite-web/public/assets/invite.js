const copy = document.querySelector('#copy');
copy?.addEventListener('click', async () => {
  const code = document.querySelector('#friend-code');
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(code.textContent);
    status.textContent = 'Friend code copied';
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = 'Copy the selected code';
  }
});
