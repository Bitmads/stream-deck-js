import sharp from "sharp";
const PImage = require('pureimage');
const streamBuffers = require('stream-buffers')

import path from "path";
import {ImageOptions, TextOptions} from "./app";

export class StreamDeckScreen{
    image:any;
    options:{width:number, height: number, backgroundColor?: string};

    constructor(options:{width:number, height: number, backgroundColor?: string}) {
        this.options = options;
        //this.init();

    }

    async init(){
        await this.getCanvas();
    }

    async getCanvas(){
        this.image = await sharp({
            create: {
                width: this.options.width,
                height: this.options.height,
                channels: 4,
                background: this.options.backgroundColor || '#000000'
            }
        }).png().toBuffer();
        console.log('create plain image DONE')
    }

    async addText(textOptions: TextOptions){
        textOptions = Object.assign({
            x: 0,
            y: 16,
            fontSize: 16,
            fillColor: "#FFFFFF"
        },textOptions);
        console.log('addText', textOptions);

        // Create Text image
        const img = PImage.make(this.options.width, this.options.height)
        const ctx = img.getContext('2d')
        ctx.clearRect(0, 0, this.options.width, this.options.height) // As of v0.1, pureimage fills the canvas with black by default.
        ctx.font = textOptions.fontSize+"pt 'Source Sans Pro'";
        ctx.USE_FONT_GLYPH_CACHING = false
        //ctx.strokeStyle = 'black'
        //ctx.lineWidth = 3
        //ctx.strokeText(textString, 8, 60)
        ctx.fillStyle = textOptions.fillColor;
        ctx.fillText(textOptions.text, textOptions.x, textOptions.y)

        const writableStreamBuffer = new streamBuffers.WritableStreamBuffer({
            initialSize: 20736, // Start at what should be the exact size we need
            incrementAmount: 1024, // Grow by 1 kilobyte each time buffer overflows.
        })

        await PImage.encodePNGToStream(img, writableStreamBuffer)

        //Add Text to the background
        this.image = await sharp(this.image).composite([{ input: writableStreamBuffer.getContents(), top: 0, left: 0, blend: 'over' }])
            .png()
            .toBuffer();

        console.log('addText DONE')

    }

    async addImage(src:string, options:ImageOptions){
        console.log('addImage',path.resolve(__dirname, src),!!this.image)
        const overlayImg = await sharp(path.resolve(__dirname, src))
            .resize(this.options.width, this.options.height,{
                fit: options.fit,
            }).toBuffer();

        this.image = await sharp(this.image)
            .composite([{ input: overlayImg, blend: options.blend || "over", gravity: options.gravity || "center" }])
            .png()
            .toBuffer();
        console.log('addImage DONE')
    }

    async get(){
        return await sharp(this.image).resize(this.options.width, this.options.height)
            .flatten()
            .resize(this.options.width, this.options.height)
            .raw()
            .toBuffer();
    }
}