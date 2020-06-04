import EventEmitter from 'events';

import { Deque } from './Dequeue';

/**
 * Sleeps the specified number of milliseconds
 * @param ms 
 */
async function sleep(ms: number) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

class ReleaseEmitter extends EventEmitter {}

function isFn(x: any) {
	return typeof x === 'function';
}

function defaultInit() {
	return '1';
}

export class Sema {
	private nrTokens: number;
	private free: Deque;
	private waiting: Deque;
	private releaseEmitter: EventEmitter;
	private noTokens: boolean;
	private pauseFn?: () => void;
	private resumeFn?: () => void;
	private paused: boolean;

	constructor(
		nr: number,
		{
			initFn = defaultInit,
			pauseFn,
			resumeFn,
			capacity = 10
		}: {
			initFn?: () => any;
			pauseFn?: () => void;
			resumeFn?: () => void;
			capacity?: number;
		} = {}
	) {
		if (isFn(pauseFn) !== isFn(resumeFn)) {
			throw new Error(
				'pauseFn and resumeFn must be both set for pausing'
			);
		}

		this.nrTokens = nr;
		this.free = new Deque(nr);
		this.waiting = new Deque(capacity);
		this.releaseEmitter = new ReleaseEmitter();
		this.noTokens = initFn === defaultInit;
		this.pauseFn = pauseFn;
		this.resumeFn = resumeFn;
		this.paused = false;

		this.releaseEmitter.on('release', token => {
			const p = this.waiting.shift();
			if (p) {
				p.resolve(token);
			} else {
				if (this.resumeFn && this.paused) {
					this.paused = false;
					this.resumeFn();
				}

				this.free.push(token);
			}
		});

		for (let i = 0; i < nr; i++) {
			this.free.push(initFn());
		}
	}

	tryAcquire(): any | undefined {
		return this.free.pop();
	}

	async acquire(): Promise<any> {
		let token = this.tryAcquire();

		if (token !== void 0) {
			return token;
		}

		return new Promise((resolve, reject) => {
			if (this.pauseFn && !this.paused) {
				this.paused = true;
				this.pauseFn();
			}

			this.waiting.push({ resolve, reject });
		});
	}

	release(token?: any): void {
		this.releaseEmitter.emit('release', this.noTokens ? '1' : token);
	}

	drain(): Promise<any[]> {
		const a = new Array(this.nrTokens);
		for (let i = 0; i < this.nrTokens; i++) {
			a[i] = this.acquire();
		}
		return Promise.all(a);
	}

	nrWaiting(): number {
		return this.waiting.length;
	}
}

export class ThrottleSema extends Sema {
	private delayMs: number;

	/**
	 * 
	 * @param nr Maximum number of callers allowed to acquire the semaphore concurrently per `intervalMs` milliseconds
	 * @param intervalMs
	 * @param uniformDistribution enforces a discrete uniform distribution over time, instead of allowing `nr` instantaneous callers and then pausing for `throttleMs` milliseconds
	 * @param options 
	 */
	constructor(
		nr: number,
		intervalMs: number = 1000,
		uniformDistribution: boolean = true,
		options: {
			initFn?: () => any;
			pauseFn?: () => void;
			resumeFn?: () => void;
			capacity?: number;
		} = {}
	) {
		if (uniformDistribution) {
			super(1, options);
			this.delayMs = intervalMs / nr;
		} else {
			super(nr, options);
			this.delayMs = 0;
		}
	}

    async acquire() : Promise<any> {
        const val = await super.acquire();
        try {
            if (this.delayMs) {
                await sleep(this.delayMs);
            }
            return val;
        } catch (e) {
			super.release(val);
			throw e;
        }
    }
}

export function RateLimit(
	rps: number,
	{
		timeUnit = 1000,
		uniformDistribution = false
	}: {
		timeUnit?: number;
		uniformDistribution?: boolean;
	} = {}
) {
	const sema = new Sema(uniformDistribution ? 1 : rps);
	const delay = uniformDistribution ? timeUnit / rps : timeUnit;

	return async function rl() {
		await sema.acquire();
		setTimeout(() => sema.release(), delay);
	};
}
