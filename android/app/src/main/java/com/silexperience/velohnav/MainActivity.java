package com.silexperience.velohnav;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.silexperience.velohnav.ar.ArNavigationPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ArNavigationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
