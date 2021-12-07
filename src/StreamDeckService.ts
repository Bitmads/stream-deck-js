import {Subject} from "rxjs";
import getActiveWindow from "active-win";
import {StreamDeckScreen} from "./StreamDeckStream";
import {openStreamDeck} from "elgato-stream-deck";
import {Page, Screen} from "./app";
const shell = require('shelljs');
const PImage = require('pureimage');

export class StreamDeckService {

    activeWindow:any;
    activeWindow$:Subject<any> = new Subject<any>();
    streamDeck:any;
    Pages:Page[];
    activePageIndex:number = 0;

    constructor(Pages:Page[]) {
        //TODO: Add more fonts
        this.Pages = Pages;

        const font = PImage.registerFont('dist/fonts/SourceSansPro-Regular.ttf','Source Sans Pro');
        font.load(async () => {
            await this.initDevice();
            await this.loadPage(this.activePageIndex);
        });

        // Loop to get the active window
        setInterval(async (x:any)=>{
            let activeWindow:any = await getActiveWindow();
            //console.log('NEW:',activeWindow)
            //console.log('OLD:',activeWindow)
            if(activeWindow?.title !== this.activeWindow?.title || activeWindow?.id !== this.activeWindow?.id){
                this.activeWindow$.next(activeWindow);
            }
        },500);
    }

    async loadPage(indexOrSlug:number | string){
        console.log('loadPage',indexOrSlug);
        let page:Page | undefined;
        if(typeof indexOrSlug === 'number'){
            page = this.Pages[indexOrSlug];
        }else{
            page = this.Pages.find(item=>item.slug === indexOrSlug);
        }
        if(page){
            for(const sK in page.screens){
                await this.renderScreen(page.screens[sK]);
            }
        }else{
            console.error('Page '+indexOrSlug+'doesn\'t exist!');
        }
    }

    async renderScreen(screenData:Screen){
        const screenImage = await new StreamDeckScreen({width: this.streamDeck.ICON_SIZE, height: this.streamDeck.ICON_SIZE, backgroundColor: screenData.backgroundColor || '#000000'});
        await screenImage.init();

        if(screenData.backgroundImage?.src && screenData.backgroundImage?.src !== ''){
            await screenImage.addImage(screenData.backgroundImage?.src,screenData.backgroundImage?.options);
        }

        if(screenData.text && Array.isArray(screenData.text)){
            for(const tk in screenData.text){
                const text = screenData.text[tk]
                if(text){
                    await screenImage.addText(text);
                }
            }
        }else{
            if(screenData.text?.text && screenData.text?.text !== ''){
                await screenImage.addText(screenData.text);
            }
        }

        const screenImg = await screenImage.get();
        this.streamDeck.fillImage(screenData.key, screenImg)
    }

    getScreen(keyOrSlug:number | string):Screen | undefined{
        let screenData:Screen | undefined;
        if(typeof keyOrSlug === 'number'){
            screenData = this.Pages[this.activePageIndex].screens.find(item=>item.key === keyOrSlug);
        }else{
            screenData = this.Pages[this.activePageIndex].screens.find(item=>item.slug === keyOrSlug);
        }

        return screenData;
    }

    async initDevice(){
        this.streamDeck = openStreamDeck() // Will throw an error if no Stream Decks are connected.
        this.streamDeck.resetToLogo();

        this.streamDeck.on('down', async (keyIndex: any) => {
            console.log('key %d down', keyIndex);
            const screenData:Screen | undefined = this.getScreen(keyIndex);
            if(screenData){
                if(screenData.onPress?.commands?.length){
                    for(const ck in screenData.onPress.commands){
                        const output = shell.exec(screenData.onPress.commands[ck]);
                    }
                }else if(screenData.onPress?.callback){
                    screenData.onPress.callback();
                }
            }
        })

        this.streamDeck.on('up', (keyIndex: any) => {
            console.log('key %d up', keyIndex)
            const screenData:Screen | undefined = this.getScreen(keyIndex);
            if(screenData){
                if(screenData.onRelease?.commands?.length){
                    for(const ck in screenData.onRelease.commands){
                        this.execCommand(screenData.onRelease.commands[ck])
                    }
                }else if(screenData.onRelease?.callback){
                    screenData.onRelease.callback();
                }
            }

        })

        this.streamDeck.on('error', (error: any) => {
            console.error(error)
        })

        this.activeWindow$.subscribe((activeWindow:any)=>{
            console.log('Active Window Changed', activeWindow?.title)
            this.activeWindow = activeWindow;
        })
    }

    execCommand(command:string){
        return new Promise((resolve, reject) => {
            const output = shell.exec(command);
            resolve(output);

        })
    }

}