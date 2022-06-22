import {Blend} from "sharp";
import {StreamDeckService} from "./StreamDeckService";

export interface ImageOptions {
    fit: 'cover' | 'contain' | 'fill' | 'inside',
    blend?: Blend
    gravity?: "center" | "centre" | "north" | "south" | "east" | "west" | "northeast" | "northwest" | "southeast" | "southwest"
}

export interface Screen {
    key: number;
    type: string;
    slug?: 'A1';
    text?: TextOptions | TextOptions[];
    // Toggle
    activeIndex?: number;
    options?: any[];
    //
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
let Pages:Page[] = [];
const streamDeckService = new StreamDeckService(Pages);

Pages = [
    {
        id:0,
        slug: 'main',
        screens: [
            {
                key: 0,
                type: 'commands',
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
                key: 5,
                type: 'commands',
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
                type: 'commands',
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
                type: 'commands',
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
                type: 'commands',
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
                    commands: ["kitty"]
                },
                onRelease:{
                    commands: []
                }
            },
            {
                key: 11,
                type: 'commands',
                text: [
                    {
                        text: 'Sound Out',
                        fontSize: 14,
                        x: 0,
                        y: 25
                    },
                    {
                        text: 'TV',
                        x: 8,
                        y: 44
                    }
                ],
                onPress:{
                    commands: ['dist/scripts/changeSoundOutput.sh tv']
                }
            },
            {
                key: 12,
                type: 'commands',
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
                key: 13,
                type: 'commands',
                text: [
                    {
                        text: 'Sound Out',
                        fontSize: 14,
                        x: 0,
                        y: 25
                    },
                    {
                        text: 'Headphones',
                        x: 8,
                        y: 44
                    }
                ],
                onPress:{
                    commands: ['dist/scripts/changeSoundOutput.sh headphones']
                }
            },
            {
                key: 14,
                type: 'toggle',
                activeIndex: 0,
                options: [
                    {
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
                            commands: ["amixer -D pulse sset Master mute"]
                        },
                        onRelease:{
                            commands: [
                            ]
                        }
                    },
                    {
                        text: {
                            text: ''
                        },
                        backgroundImage:{
                            src: 'images/unmute.png',
                            options: {
                                fit: "inside",
                            }
                        },
                        backgroundColor: '#3a333b',
                        onPress: {
                            commands: ["amixer -D pulse sset Master unmute"]
                        },
                        onRelease:{
                            commands: [
                            ]
                        }
                    }
                ]
            },

        ]
    },
];

async function start(){
    const SDS = new StreamDeckService(Pages);
    await streamDeckService.init();
    await streamDeckService.loadPage(Pages[0]);
}

start().then(()=>{
    //
})

// name parameter can be a regex
function changeWindowByName(name:string){
    return "xdotool search --desktop 0 --name '"+name+"' windowactivate";
}

function changeWindowByClass(className:string){
    return "xdotool search --desktop 0 --classname '"+className+"' windowactivate";
}

/// Audio Outputs
// Samsung TV: pactl set-card-profile alsa_card.pci-0000_0b_00.1 output:hdmi-stereo
// Main ASUS Monitor: pactl set-card-profile alsa_card.pci-0000_0b_00.1 output:hdmi-stereo-extra2
// Headphones: pactl set-card-profile alsa_card.pci-0000_0d_00.4 output:analog-stereo
// Inactivate:  pactl set-card-profile alsa_card.pci-0000_0d_00.4 off

// TODO: Add to the settler shell script: pactl set-default-sink alsa_output.pci-0000_0b_00.1.hdmi-stereo-extra2


