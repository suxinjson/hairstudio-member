package com.hairstudio.memberapp;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CloudDevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
