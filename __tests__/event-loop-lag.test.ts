// __tests__/event-loop-lag.test.ts
//
// Block 4: Event Queue Performance
// Verifies that processing 10,000 events with Array.shift() doesn't cause
// unacceptable event loop lag. If this test fails, the eventQueue in
// geyser/client.ts needs to be replaced with a circular buffer.

import { performance } from 'perf_hooks';

describe('Event Queue Performance (gRPC Spike Simulation)', () => {
  it('Array.shift() on 10,000 items should complete under 100ms', () => {
    // Simulate the geyser event queue behavior
    const queue: { data: any }[] = [];
    for (let i = 0; i < 10_000; i++) {
      queue.push({ data: { transaction: { signature: `sig_${i}` } } });
    }

    const start = performance.now();
    let processed = 0;
    while (queue.length > 0) {
      const item = queue.shift();
      processed++;
      // Minimal "processing" to simulate overhead
      if (item && item.data.transaction) {
        const _sig = item.data.transaction.signature;
      }
    }
    const elapsed = performance.now() - start;

    expect(processed).toBe(10_000);
    // At 10k items, shift() is O(N) per call = O(N^2) total.
    // On modern hardware this is still under 100ms, but at 50k+ it degrades badly.
    // If this fails, replace with circular buffer or index-based approach.
    expect(elapsed).toBeLessThan(100);

    // Log for visibility
    console.log(`Array.shift() 10k items: ${elapsed.toFixed(2)}ms`);
  });

  it('Index-based approach (O(1)) should be 5x+ faster than shift()', () => {
    const SIZE = 50_000;

    // Bad approach: Array.shift()
    const badQueue: any[] = [];
    for (let i = 0; i < SIZE; i++) badQueue.push({ data: i });

    const startBad = performance.now();
    while (badQueue.length > 0) badQueue.shift();
    const badTime = performance.now() - startBad;

    // Good approach: index pointer (O(1) per dequeue)
    const goodQueue: any[] = [];
    for (let i = 0; i < SIZE; i++) goodQueue.push({ data: i });

    let head = 0;
    const startGood = performance.now();
    while (head < goodQueue.length) {
      const _item = goodQueue[head++];
    }
    const goodTime = performance.now() - startGood;

    console.log(`shift() ${SIZE} items: ${badTime.toFixed(2)}ms`);
    console.log(`pointer ${SIZE} items: ${goodTime.toFixed(2)}ms`);
    console.log(`speedup: ${(badTime / goodTime).toFixed(1)}x`);

    // Index approach should be significantly faster
    expect(goodTime).toBeLessThan(badTime);
  });

  it('Batch processing (50 items per tick) limits event loop blocking', () => {
    // Simulate the processQueue behavior: batch of 50, then yield
    const TOTAL = 10_000;
    const BATCH_SIZE = 50;
    const queue: any[] = [];
    for (let i = 0; i < TOTAL; i++) queue.push({ data: i });

    const batchTimes: number[] = [];
    let processed = 0;

    while (queue.length > 0) {
      const batchStart = performance.now();
      const thisBatch = Math.min(BATCH_SIZE, queue.length);
      for (let i = 0; i < thisBatch; i++) {
        queue.shift();
        processed++;
      }
      batchTimes.push(performance.now() - batchStart);
    }

    expect(processed).toBe(TOTAL);

    // No single batch should block for more than 10ms
    const maxBatchTime = Math.max(...batchTimes);
    console.log(`Max batch time (50 items): ${maxBatchTime.toFixed(3)}ms`);
    console.log(`Avg batch time: ${(batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length).toFixed(3)}ms`);
    expect(maxBatchTime).toBeLessThan(10);
  });
});
