import {Blend} from "sharp";
import {StreamDeckService} from "./StreamDeckService";

export interface ImageOptions {
    fit: 'cover' | 'contain' | 'fill' | 'inside',
    blend?: Blend
    gravity?: "center" | "centre" | "north" | "south" | "east" | "west" | "northeast" | "northwest" | "southeast" | "southwest"
}

export interface Screen {
    key: number;
    slug?: 'A1';
    text?: TextOptions | TextOptions[];
    backgroundColor?: string;
    backgroundImage?: {
        src: string,
        options: ImageOptions
    };
    onPress?:{
        callback?: any;
        commands?: string[];
    };
    onRelease?:{
        callback?: any;
        commands?: string[];
    };
}

export type Page = {
    id: number,
    slug?:string,
    screens: Screen[]
};

export type TextOptions = {
    text:string,
    x?:number | 'left' | 'center' | 'right',
    y?:number | 'top' | 'middle' | 'bottom',
    fontSize?: number,
    fillColor?: string
}

const Pages:Page[] = [
    {
        id:0,
        slug: 'main',
        screens: [
            {
                key: 0,
                text: [
                    {
                        text: 'Focus active',
                        fontSize: 14,
                        x: 0,
                        y: 25
                    },
                    {
                        text: 'Window',
                        x: 8,
                        y: 44
                    }
                ],
                onPress:{
                    commands: ['dist/scripts/window2Primary.sh']
                },
                backgroundColor: '#45b226'
            },
            {
                key: 1,
                text: [
                    {
                        text: 'Sound Out',
                        fontSize: 14,
                        x: 0,
                        y: 25
                    },
                    {
                        text: 'Asus',
                        x: 8,
                        y: 44
                    }
                ],
                onPress:{
                    commands: ['dist/scripts/changeSoundOutput.sh asus']
                }
            },
            {
                key: 3,
                text: {
                    text: '3:A4 OK',
                    x: 18,
                    y: 44
                },
                onPress: {
                    commands: ['strd open https://bitmads.com']
                },
            },
            {
                key: 6,
                text: {
                    text: '6:B2 OK'
                },
                backgroundImage:{
                    src: 'images/test.png',
                    options: {
                        fit: "inside",
                    }
                },
                backgroundColor: '#456785',
                onPress: {
                    callback: ()=>{console.log('B2 onPress')}
                },
                onRelease:{
                    callback: ()=>{console.log('B2 onRelease')}
                }
            },
            {
                key: 7,
                text: {
                    text: '7:B3 OK'
                },
                backgroundImage:{
                    src: 'images/portrait-test.jpg',
                    options: {
                        fit: "inside",
                    }
                },
                backgroundColor: '#96152d',
                onPress: {
                    commands: [changeWindowByClass('google-chrome')]
                },
                onRelease:{
                    commands: [changeWindowByClass('jetbrains-phpstorm')]
                }
            },
            {
                key: 10,
                text: {
                    text: ''
                },
                backgroundImage:{
                    src: 'images/terminal-color.png',
                    options: {
                        fit: "inside",
                    }
                },
                backgroundColor: '#3a333b',
                onPress: {
                    commands: ["gnome-terminal"]
                },
                onRelease:{
                    commands: []
                }
            },
            {
                key: 14,
                text: {
                    text: ''
                },
                backgroundImage:{
                    src: 'images/mute-circle.png',
                    options: {
                        fit: "inside",
                    }
                },
                backgroundColor: '#3a333b',
                onPress: {
                    commands: ["amixer -D pulse sset Master 0%"]
                },
                onRelease:{
                    commands: []
                }
            }
        ]
    },
];

// name parameter can be a regex
function changeWindowByName(name:string){
    return "xdotool search --desktop 0 --name '"+name+"' windowactivate";
}

function changeWindowByClass(className:string){
    return "xdotool search --desktop 0 --classname '"+className+"' windowactivate";
}


new StreamDeckService(Pages);