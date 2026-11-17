'use strict';

const XwrInput = {
  prepareGamepad(gamepad, {pads = () => navigator.getGamepads(), focused = () => document.hasFocus()} = {}) {
    const readState = gamepad.getGamepadState.bind(gamepad);
    gamepad.getGamepad = index => {
      const pad = pads()[index];
      if (!pad || pad.connected === false) return undefined;
      // The vendor mapping includes Guide (button 16), which some browser pads lack.
      return {
        index:pad.index, vibrationActuator:pad.vibrationActuator,
        buttons:Array.from({length:Math.max(17, pad.buttons.length)}, (_, i) => ({
          value:Number.isFinite(pad.buttons[i]?.value) ? pad.buttons[i].value : 0,
        })),
        axes:Array.from({length:Math.max(4, pad.axes.length)}, (_, i) =>
          Number.isFinite(pad.axes[i]) ? pad.axes[i] : 0),
      };
    };
    gamepad.getGamepadState = () => {
      const hasFocus=focused();
      const wasFocused=gamepad._isFocused;
      gamepad._isFocused=hasFocus;
      if (!hasFocus) {
        gamepad._gamepadOverride.buttons={};
        return wasFocused ? {...gamepad.getDefaultFamepadFrame(), GamepadIndex:gamepad._index} : undefined;
      }
      if (!gamepad.getGamepad(gamepad.getPhysicalGamepadId())) {
        gamepad._physicalGamepadId = -1;
        gamepad.detectActiveGamepad();
      }
      return readState();
    };
    return gamepad;
  },

  install(player, {schedule = setTimeout, cancel = clearTimeout, onError = error => console.error('input', error)} = {}) {
    const {input, control} = player._channels;
    const state = {started:false, stopped:false, ticks:0, frames:0, error:null};
    input._xwrInput = state;
    const nativeStart = input.start.bind(input), nativeDestroy = input.destroy.bind(input);
    let requested = false, timer;
    const tryStart = () => {
      if (!requested || state.started || state.stopped ||
          !player._channels.message._handshakeCompleted ||
          input._dataChannel.readyState !== 'open' || control._dataChannel.readyState !== 'open') return;
      state.started = true;
      try { nativeStart(); }
      catch (error) { state.error=error.name || 'Error'; onError(error); }
    };
    input.start = () => { requested = true; tryStart(); };
    input.gamepadStateLoop = () => {
      if (state.stopped || state.error) return;
      try {
        if (input._dataChannel.readyState === 'open' && control._dataChannel.readyState === 'open') {
          const frames = Object.values(control.getGamepadHandlers())
            .filter(handler => handler && typeof handler.getGamepadState === 'function')
            .map(handler => handler.getGamepadState()).filter(Boolean);
          // Input must not wait for requestVideoFrameCallback. A stalled or
          // background video renderer must not accumulate unsent controller frames.
          if (frames.length) { input.queueGamepadFrames(frames, true); state.frames += frames.length; }
          state.ticks++;
        }
        timer = schedule(input.gamepadStateLoop, 16);
      } catch (error) {
        state.error = error.name || 'Error';
        onError(error);
      }
    };
    input.destroy = () => {
      state.stopped = true;
      cancel(timer);
      input._dataChannel.removeEventListener('open', tryStart);
      control._dataChannel.removeEventListener('open', tryStart);
      nativeDestroy();
    };
    input._dataChannel.addEventListener('open', tryStart);
    control._dataChannel.addEventListener('open', tryStart);
    return state;
  },
};
if (typeof module !== 'undefined') module.exports = XwrInput;
