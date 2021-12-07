# stream-deck-js

A cross-platform stream-deck client for coders.
This is not a ready-to-use package, this is a wrapper for the very lightweight https://www.npmjs.com/package/@elgato-stream-deck/node.
Basically I created an SDK for making image drawing, text placement and push/release handling easier, you need to think and code less, but you'll still need both to use this package.

I'm not maintenaning this package, there's no support, I created this package because I'm using Linux and unfortunately Elgato doesn't care about Linux users at all. So I had to solve this for myself. I know there's another linux based UI, but I didn't like it, because I couldn't control it the way I wanted.


I'm planning to add a web based UI later, for now you can use JSON to interact with your device:

IMPORTANT: This is not going to work for you just like that. Many examples below based on my environment, and custom stuff. For example the Audio Output selector button is not going to work for you without adjusting `dist/scripts/changeSoundOutput.sh`.

Track down the code (it's like 1 hour to understand the whole thing), starting from `app.ts`.

```
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
```

By improving the code you can even change your layout based on the active window/app, take a look how I catch and handle the window changed events for better understanding.
