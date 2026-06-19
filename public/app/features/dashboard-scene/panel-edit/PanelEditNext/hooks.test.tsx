import { act, renderHook } from '@testing-library/react';

import { useHorizontalResize, useVerticalResize } from './hooks';

describe('panel editor resize hooks', () => {
  it('keeps one horizontal drag listener across state updates and removes it on unmount', () => {
    const handle = document.createElement('div');
    const addEventListener = jest.spyOn(handle, 'addEventListener');
    const removeEventListener = jest.spyOn(handle, 'removeEventListener');
    const { result, unmount } = renderHook(() =>
      useHorizontalResize({ initialWidth: 320, minWidth: 300, maxWidth: 420 })
    );

    act(() => result.current.handleRef(handle));
    const initialHandleRef = result.current.handleRef;
    act(() => result.current.setWidth(360));

    expect(result.current.handleRef).toBe(initialHandleRef);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith('mousedown', expect.any(Function));

    unmount();

    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith('mousedown', expect.any(Function));
  });

  it('keeps one vertical drag listener across state updates and removes it on unmount', () => {
    const handle = document.createElement('div');
    const addEventListener = jest.spyOn(handle, 'addEventListener');
    const removeEventListener = jest.spyOn(handle, 'removeEventListener');
    const { result, unmount } = renderHook(() =>
      useVerticalResize({ initialHeight: 350, minHeight: 0, maxHeight: 600 })
    );

    act(() => result.current.handleRef(handle));
    const initialHandleRef = result.current.handleRef;
    act(() => result.current.setHeight(400));

    expect(result.current.handleRef).toBe(initialHandleRef);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith('mousedown', expect.any(Function));

    unmount();

    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith('mousedown', expect.any(Function));
  });
});
