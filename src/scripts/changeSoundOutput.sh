#!/bin/bash



if [ -z "$1" ]; then
    SELECTED_OUTPUT_DEVICE="asus"
else
    SELECTED_OUTPUT_DEVICE=$1
fi

echo "Changing Audio Output to: ${SELECTED_OUTPUT_DEVICE}"

#pacmd list-sinks | grep -e name: -e index -e description -e muted
#pacmd list |grep -e 'active profile'

### ASUS 32" - Main Display
if [ "${SELECTED_OUTPUT_DEVICE}" = "asus" ]; then
  pactl set-card-profile alsa_card.pci-0000_0d_00.4 off
  pactl set-card-profile alsa_card.pci-0000_0b_00.1 output:hdmi-stereo-extra2
fi
### ASUS 32" - Secondary Display
if [ "${SELECTED_OUTPUT_DEVICE}" = "asus2" ]; then
  pactl set-card-profile alsa_card.pci-0000_0d_00.4 off
  pactl set-card-profile alsa_card.pci-0000_0b_00.1 output:hdmi-stereo-extra1
fi
### TV 55"
if [ "${SELECTED_OUTPUT_DEVICE}" = "tv" ]; then
  pactl set-card-profile alsa_card.pci-0000_0d_00.4 off
  pactl set-card-profile alsa_card.pci-0000_0b_00.1 output:hdmi-stereo
fi

### Headphones
if [ "${SELECTED_OUTPUT_DEVICE}" = "headphones" ]; then
  pactl set-card-profile alsa_card.pci-0000_0d_00.4 output:analog-stereo
fi