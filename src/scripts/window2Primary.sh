#!/bin/bash

## Check if xdotool command exists, if not we can install it
if ! command -v xdotool &> /dev/null
then
  echo "xdotool command is missing, let's try to install it!"
  sudo apt-get install xdotool -y
fi

## Check if we have the window ID otherwise we move the currently active window as default
if [ -z "$1" ]; then
    WINDOW_ID=$(xdotool getactivewindow)
else
    WINDOW_ID=$1
fi


#DEBUG=$(xrandr | grep -w primary  | awk -F'[ +x]' '{print $1, $2, $3, $4, $5, $6, $7}')
#PRIMARY_DISPLAY_NAME=$(xrandr | grep -w primary  | awk -F'[ +]' '{print $1}')

#PRIMARY_DISPLAY_WIDTH=$(xrandr | grep -w "${PRIMARY_DISPLAY_NAME}"  | awk -F'[ +x]' '{print $4}')
#PRIMARY_DISPLAY_WIDTH_OFFSET=$(xrandr | grep -w "${PRIMARY_DISPLAY_NAME}"  | awk -F'[ +x]' '{print $6}')
#PRIMARY_DISPLAY_XMAX=$((${PRIMARY_DISPLAY_WIDTH_OFFSET}+${PRIMARY_DISPLAY_WIDTH}))

#PRIMARY_DISPLAY_HEIGHT=$(xrandr | grep -w "${PRIMARY_DISPLAY_NAME}"  | awk -F'[ +x]' '{print $5}')
#PRIMARY_DISPLAY_HEIGHT_OFFSET=$(xrandr | grep -w "${PRIMARY_DISPLAY_NAME}"  | awk -F'[ +x]' '{print $7}')
#PRIMARY_DISPLAY_YMAX=$((${PRIMARY_DISPLAY_HEIGHT_OFFSET}+${PRIMARY_DISPLAY_HEIGHT}))

#echo "${PRIMARY_DISPLAY_WIDTH} + ${PRIMARY_DISPLAY_WIDTH_OFFSET} = ${PRIMARY_DISPLAY_XMAX}";
#echo "---------------------------"
#echo "${PRIMARY_DISPLAY_HEIGHT} + ${PRIMARY_DISPLAY_HEIGHT_OFFSET} = ${PRIMARY_DISPLAY_YMAX}";


#xdotool windowmove ${WINDOW_ID} ${PRIMARY_DISPLAY_WIDTH_OFFSET} ${PRIMARY_DISPLAY_HEIGHT_OFFSET}
#xdotool windowactivate ${WINDOW_ID}


## SHORT
xdotool windowmove ${WINDOW_ID} $(xrandr | grep -w "$(xrandr | grep -w primary  | awk -F'[ +]' '{print $1}')"  | awk -F'[ +x]' '{print $6}') $(xrandr | grep -w "$(xrandr | grep -w primary  | awk -F'[ +]' '{print $1}')"  | awk -F'[ +x]' '{print $7}')
xdotool windowactivate ${WINDOW_ID}