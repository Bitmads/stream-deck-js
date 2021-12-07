#!/bin/bash



if [ -z "$1" ]; then
    SELECTED_OUTPUT_DEVICE="asus"
else
    SELECTED_OUTPUT_DEVICE=$1
fi


#pacmd list-sinks | grep -e name: -e index -e description -e muted
#pacmd list |grep -e 'active profile'

### ASUS 32"
if [ "${SELECTED_OUTPUT_DEVICE}" = "asus" ]; then
  pactl set-card-profile 1 output:hdmi-stereo-extra2
fi
### TV 55"
if [ "${SELECTED_OUTPUT_DEVICE}" = "tv" ]; then
  pactl set-card-profile 1 output:hdmi-stereo
fi
### SAMSUNG 27"
if [ "${SELECTED_OUTPUT_DEVICE}" = "samsung" ]; then
  pactl set-card-profile 1 output:hdmi-stereo-extra1
fi