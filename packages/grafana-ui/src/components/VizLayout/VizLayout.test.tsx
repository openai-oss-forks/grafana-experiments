import { render, screen } from '@testing-library/react';
import { useEffect } from 'react';

import { createTheme } from '@grafana/data';

import { mockThemeContext } from '../../themes/ThemeContext';

import { VizLayout } from './VizLayout';

describe('VizLayout retained legend geometry', () => {
  let restoreThemeContext: () => void;
  let legendWidth = 100;
  let legendHeight = 20;

  beforeEach(() => {
    restoreThemeContext = mockThemeContext(createTheme());
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: legendWidth,
          height: legendHeight,
          top: 0,
          right: legendWidth,
          bottom: legendHeight,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect
    );
  });

  afterEach(() => {
    restoreThemeContext();
    jest.restoreAllMocks();
    legendWidth = 100;
    legendHeight = 20;
  });

  test('keeps the first session rectangle and measures a replacement session independently', () => {
    const renderLayout = (legendSizeKey: string) => (
      <VizLayout
        width={400}
        height={200}
        legend={<VizLayout.Legend placement="bottom">Legend</VizLayout.Legend>}
        legendSizeKey={legendSizeKey}
        lockLegendSize
        mountBeforeLegendMeasure
      >
        {(width, height) => <div data-testid="plot-size">{`${width}x${height}`}</div>}
      </VizLayout>
    );

    const view = render(renderLayout('request-1'));
    expect(screen.getByTestId('plot-size')).toHaveTextContent('400x180');

    legendHeight = 60;
    view.rerender(renderLayout('request-1'));
    expect(screen.getByTestId('plot-size')).toHaveTextContent('400x180');

    view.rerender(renderLayout('request-2'));
    expect(screen.getByTestId('plot-size')).toHaveTextContent('400x140');
  });

  test('keeps the plot mounted when the stable legend slot changes visibility', () => {
    const onMount = jest.fn();
    const onUnmount = jest.fn();
    const Plot = () => {
      useEffect(() => {
        onMount();
        return onUnmount;
      }, []);
      return <div data-testid="plot" />;
    };
    const renderLayout = (showLegend: boolean) => (
      <VizLayout
        width={400}
        height={200}
        legend={showLegend ? <VizLayout.Legend placement="bottom">Legend</VizLayout.Legend> : null}
        stableLegendSlot
        mountBeforeLegendMeasure
      >
        {() => <Plot />}
      </VizLayout>
    );

    const view = render(renderLayout(false));
    view.rerender(renderLayout(true));
    view.rerender(renderLayout(false));

    expect(screen.getByTestId('plot')).toBeInTheDocument();
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
  });
});
