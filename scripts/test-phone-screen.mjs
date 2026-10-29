import assert from 'node:assert/strict';
import { detectProtectedScreen } from '../src/android-phone-screen.js';

const window = ({ index = 0, title = 'com.example/.PasswordPage', flags = 'LAYOUT_IN_SCREEN SECURE LAYOUT_INSET_DECOR', surface = true, onScreen = true, visible = true, view = '0x0', policy = true } = {}) => `
  Window #${index} Window{abc123 u0 ${title}}:
    mAttrs=WM.LayoutParams{(0,0)(fillxfill) sim={adjust=resize} ty=BASE_APPLICATION
      fl=${flags}}
    mViewVisibility=${view} mHaveFrame=true
    mPolicyVisibility=${policy}
    mHasSurface=${surface} isReadyForDisplay()=true
    isOnScreen=${onScreen}
    isVisible=${visible}
`;

assert.deepEqual(detectProtectedScreen(window()), { protected: true, secureWindowCount: 1, visibleSecureWindowCount: 1 });
for (const hidden of [{ surface: false }, { onScreen: false }, { visible: false }, { view: '0x8' }, { policy: false }]) {
  assert.deepEqual(detectProtectedScreen(window(hidden)), { protected: false, secureWindowCount: 1, visibleSecureWindowCount: 0 });
}
assert.equal(detectProtectedScreen(window({ flags: 'LAYOUT_IN_SCREEN HARDWARE_ACCELERATED' })).protected, false);
assert.equal(detectProtectedScreen(window({ flags: '0x2000' })).protected, true);
assert.equal(detectProtectedScreen(window({ flags: '0x1000' })).protected, false);
assert.equal(detectProtectedScreen(window({ flags: 'LAYOUT_IN_SCREEN SECURELY_NAMED' })).protected, false);
assert.equal(detectProtectedScreen(window({ title: 'SECURE fl=SECURE isVisible=true', flags: 'LAYOUT_IN_SCREEN' })).protected, false);
assert.deepEqual(detectProtectedScreen(window({ visible: false }) + window({ index: 1, flags: 'LAYOUT_IN_SCREEN' })),
  { protected: false, secureWindowCount: 1, visibleSecureWindowCount: 0 });
assert.deepEqual(detectProtectedScreen(window({ visible: false }) + window({ index: 1 })),
  { protected: true, secureWindowCount: 2, visibleSecureWindowCount: 1 });
for (const malformed of [undefined, null, 42, '', 'SECURE isVisible=true mHasSurface=true', 'Window #0 Window{missing-close:\nfl=SECURE\nmHasSurface=true\nisVisible=true', window().replace(/\s+isOnScreen=true|\s+isVisible=true/g, '')]) {
  assert.equal(detectProtectedScreen(malformed).protected, false);
}
const sameLine = window().replace(/\n\s+fl=/, ' fl=');
assert.equal(detectProtectedScreen(sameLine).protected, true);
assert.deepEqual(Object.keys(detectProtectedScreen(window())), ['protected', 'secureWindowCount', 'visibleSecureWindowCount']);
console.log('Phone protected-screen diagnostics passed (visible/hidden/malformed/flag/title cases).');
