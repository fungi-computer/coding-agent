/**
 * Worker stub for photon image support.
 * Workers don't have access to the native photon module.
 * Returns a stub object so that code compiles, but any image operations
 * will throw errors at runtime.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PhotonImageType = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SamplingFilter: any = {
	Lanczos3: 0,
	Lanczos5: 1,
	Triangle: 2,
	Mitchell: 3,
	CatmullRom: 4,
	Nearest: 5,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class PhotonImage {
	constructor(_dst: Uint8Array, _height: number, _width: number) {
		throw new Error("PhotonImage is not supported in Workers");
	}
	static new_from_byteslice(_bytes: Uint8Array): PhotonImage {
		throw new Error("PhotonImage is not supported in Workers");
	}
	get_bytes(): Uint8Array {
		throw new Error("PhotonImage is not supported in Workers");
	}
	get_bytes_jpeg(_quality: number): Uint8Array {
		throw new Error("PhotonImage is not supported in Workers");
	}
	get_width(): number {
		throw new Error("PhotonImage is not supported in Workers");
	}
	get_height(): number {
		throw new Error("PhotonImage is not supported in Workers");
	}
	free(): void {
		throw new Error("PhotonImage is not supported in Workers");
	}
}

export function resize(
	_image: PhotonImage,
	_width: number,
	_height: number,
	_filter: number,
): PhotonImage {
	throw new Error("resize is not supported in Workers");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const photonModule: any = {
	PhotonImage,
	resize,
	SamplingFilter,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPhoton(): Promise<any> {
	return photonModule;
}
