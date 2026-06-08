import { render } from '@testing-library/react';

import { UPlotConfigBuilder } from '../config/UPlotConfigBuilder';

import { KeyboardPlugin } from './KeyboardPlugin';

describe('KeyboardPlugin', () => {
  it('cancels keyboard animation when uPlot is destroyed', () => {
    const requestAnimationFrame = jest.spyOn(window, 'requestAnimationFrame').mockReturnValue(42);
    const cancelAnimationFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const root = document.createElement('div');
    const destroyHooks: Array<() => void> = [];
    const plot = {
      root,
      over: document.createElement('div'),
      cursor: { left: 0, top: 0 },
      hooks: { destroy: destroyHooks },
      setCursor: jest.fn(),
      setSelect: jest.fn(),
    };
    const config = new UPlotConfigBuilder();

    render(<KeyboardPlugin config={config} />);
    const initHook = config.getConfig().hooks?.init?.[0];

    // The test double includes only the uPlot surface used by the keyboard plugin.
    // @ts-expect-error
    initHook?.(plot);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    destroyHooks.forEach((destroy) => destroy());
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
