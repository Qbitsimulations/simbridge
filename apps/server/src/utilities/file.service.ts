import { readdir, readFile } from 'fs/promises';
import { HttpException, HttpStatus, Injectable, Logger, StreamableFile } from '@nestjs/common';
import { readFileSync, lstatSync } from 'fs';
import * as xml2js from 'xml2js';
import { getDocument, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf';
import { join } from 'path';
import { getExecutablePath } from './pathUtil';
import { pdfToPng } from './pdfConversion';

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

pdfjsLib.GlobalWorkerOptions.workerSrc = join(getExecutablePath(), 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js');

@Injectable()
export class FileService {
    private readonly logger = new Logger(FileService.name);

    private pdfCache = new Map<string, PDFDocumentProxy>();

    private pngCache = new Map<string, Buffer>();

    async getFileCount(directory: string): Promise<number> {
        try {
            this.logger.debug(`Retrieving number of files in folder: ${directory}`);
            const dir = join(getExecutablePath(), directory);
            this.checkFilePathSafety(dir);
            const retrievedDir = await readdir(dir, { withFileTypes: true });
            const fileNames = retrievedDir.filter((dir) => dir.isFile()).map((dir) => dir.name);
            return fileNames.length;
        } catch (err) {
            const message = `Error reading directory: ${directory}`;
            this.logger.error(message, err);
            throw new HttpException(message, HttpStatus.NOT_FOUND);
        }
    }

    async getFiles(directory: string): Promise<{ fileNames: string[]; files: Buffer[]; }> {
        try {
            this.logger.debug(`Reading all files in directory: ${directory}`);

            const dir = join(getExecutablePath(), directory);
            this.checkFilePathSafety(dir);
            const fileNames = (await readdir(dir, { withFileTypes: true })).filter((dir) => dir.isFile()).map((dir) => dir.name);

            const files: Buffer[] = [];
            for (const fileName of fileNames) {
                files.push(await this.getFile(directory, fileName));
            }
            return { fileNames, files };
        } catch (err) {
            const message = `Error reading directory: ${directory}`;
            this.logger.error(message, err);
            throw new HttpException(message, HttpStatus.NOT_FOUND);
        }
    }

    async getFilenames(directory: string): Promise<string[]> {
        try {
            this.logger.debug(`Reading all files in directory: ${directory}`);
            const dir = join(getExecutablePath(), directory);
            this.checkFilePathSafety(dir);
            return (await readdir(dir, { withFileTypes: true })).filter((dir) => dir.isFile()).map((dir) => dir.name);
        } catch (err) {
            const message = `Error reading directory: ${directory}`;
            this.logger.error(message, err);
            throw new HttpException(message, HttpStatus.NOT_FOUND);
        }
    }

    async getFoldernames(directory: string): Promise<string[]> {
        try {
            this.logger.debug(`Reading all Dirs in directory: ${directory}`);
            const dir = join(process.cwd(), directory);
            this.checkFilePathSafety(dir);
            return (await readdir(dir, { withFileTypes: true })).filter((dir) => dir.isDirectory()).map((dir) => dir.name);
        } catch (err) {
            const message = `Error reading directory: ${directory}`;
            this.logger.error(message, err);
            throw new HttpException(message, HttpStatus.NOT_FOUND);
        }
    }

    async getFile(directory: string, fileName: string): Promise<Buffer> {
        try {
            this.logger.debug(`Retrieving file: ${fileName} in folder: ${directory}`);

            const path = join(getExecutablePath(), directory, fileName);
            this.checkFilePathSafety(path);

            if (!lstatSync(path).isFile()) {
                return Promise.reject(new Error(`${path} is not a file`));
            }
            const file = await readFile(path);
            return file;
        } catch (err) {
            const message = `Error retrieving file: ${fileName} in folder: ${directory}`;
            this.logger.error(message, err);
            throw new HttpException(message, HttpStatus.NOT_FOUND);
        }
    }

    async getNumberOfPdfPages(Directory: string, fileName: string): Promise<number> {
        const retrievedFile = await this.getFile(Directory, fileName);
        return getDocument({ data: retrievedFile }).promise.then((document) => document.numPages);
    }

    /**
     * Calling this function checks the safety of the supplied file path and throws an error if it deemed not safe against various potential attacks.
     * @param filePath
     */
    checkFilePathSafety(filePath: string): void {
        if (filePath.indexOf('\0') !== -1) {
            throw new HttpException('Unexpected null byte encountered', HttpStatus.UNPROCESSABLE_ENTITY);
        }

        if (filePath.indexOf(getExecutablePath()) !== 0) {
            throw new HttpException('Unacceptable file path', HttpStatus.UNPROCESSABLE_ENTITY);
        }
    }

    async getConvertedPdfFile(directory:string, fileName: string, pageNumber: number, scale: number = 4): Promise<StreamableFile> {
        // Some PDFs need external cmaps.
        const CMAP_URL = `${join(getExecutablePath(), 'node_modules', 'pdfjs-dist', 'cmaps')}/`;
        const CMAP_PACKED = true;

        // Where the standard fonts are located.
        const STANDARD_FONT_DATA_URL = `${join(getExecutablePath(), 'node_modules', 'pdfjs-dist', 'standard_fonts')}/`;

        try {
            const conversionFilePath = join(getExecutablePath(), directory, fileName);

            this.checkFilePathSafety(conversionFilePath);

            const pngKey = `${conversionFilePath};;${pageNumber};;${scale}`;
            if (this.pngCache.has(pngKey)) {
                return new StreamableFile(this.pngCache.get(`${conversionFilePath};;${pageNumber};;${scale}`));
            }

            if (!this.pdfCache.has(conversionFilePath)) {
                const file = readFileSync(conversionFilePath);
                const data = new Uint8Array(file);

                // Load the PDF file.
                const pdfDocument = await getDocument({
                    data,
                    cMapUrl: CMAP_URL,
                    cMapPacked: CMAP_PACKED,
                    standardFontDataUrl: STANDARD_FONT_DATA_URL,
                }).promise;

                this.pdfCache.set(conversionFilePath, pdfDocument);
            }

            const file = this.pdfCache.get(conversionFilePath);

            const pngBuffer = await pdfToPng(file, pageNumber, scale);

            if (!this.pngCache.has(pngKey)) {
                this.pngCache.set(pngKey, pngBuffer);
            }

            return new StreamableFile(pngBuffer);
        } catch (err) {
            const message = `Error converting PDF to PNG: ${fileName}`;
            this.logger.log(message, err);
            throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    async getFileStream(directory: string, fileName: string): Promise<StreamableFile> {
        return new StreamableFile(await this.getFile(directory, fileName));
    }

    async convertXmlToJson(xmlBuffer: Buffer): Promise<string> {
        return xml2js.parseStringPromise(xmlBuffer.toString(), { mergeAttrs: true, explicitChildren: true, explicitArray: false })
            .then((result) => JSON.stringify(result))
            .catch((err) => {
                const message = 'Error converting XML to JSON';
                this.logger.error(message, err);
                throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
            });
    }
}
