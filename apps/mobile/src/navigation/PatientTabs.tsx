import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createStackNavigator }     from "@react-navigation/stack";
import { Colors, MedicineCategory } from "@mediguard/shared";
import { Text, View, StyleSheet }   from "react-native";
import { Ionicons }                 from "@expo/vector-icons";

import { HomeScreen }               from "@/screens/patient/HomeScreen";
import { MedicineInventoryScreen }  from "@/screens/patient/MedicineInventoryScreen";
import { MedicineDetailScreen }     from "@/screens/patient/MedicineDetailScreen";
import { AddMedicineScreen }        from "@/screens/patient/AddMedicineScreen";
import { ScannerScreen }            from "@/screens/patient/ScannerScreen";
import { DoseTrackerScreen }        from "@/screens/patient/DoseTrackerScreen";
import { ProfileScreen }            from "@/screens/patient/ProfileScreen";

const Tab   = createBottomTabNavigator();
const Stack = createStackNavigator();

export type InventoryStackParams = {
  Inventory:      undefined;
  MedicineDetail: { medicineId: string };
  AddMedicine: {
    medicineId?:      string;
    prefillName?:     string;
    prefillDosage?:   string;
    prefillCategory?: MedicineCategory;
    prefillExpiry?:   string;
    // Set whenever the medicine was reached from a scan, so the confirmed
    // name can be written back against that barcode (services/barcodeRegistry).
    barcode?:         string;
  };
};

type IconSet = { active: keyof typeof Ionicons.glyphMap; inactive: keyof typeof Ionicons.glyphMap };

const TAB_ICONS: Record<string, IconSet> = {
  Home:      { active: "home",         inactive: "home-outline"         },
  Inventory: { active: "medical",      inactive: "medical-outline"      },
  Scan:      { active: "scan",         inactive: "scan-outline"         },
  Tracker:   { active: "alarm",        inactive: "alarm-outline"        },
  Profile:   { active: "person",       inactive: "person-outline"       },
};

function HomeStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Home" component={HomeScreen} />
    </Stack.Navigator>
  );
}

function InventoryStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Inventory"      component={MedicineInventoryScreen} />
      <Stack.Screen name="MedicineDetail" component={MedicineDetailScreen} />
      <Stack.Screen name="AddMedicine"    component={AddMedicineScreen} />
    </Stack.Navigator>
  );
}

export function PatientTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => {
        const icons = TAB_ICONS[route.name];
        return {
          headerShown: false,
          tabBarActiveTintColor:   Colors.primary,
          tabBarInactiveTintColor: Colors.textSecondary,
          tabBarStyle: ts.bar,
          tabBarLabel: ({ focused, color }) => (
            <Text style={[ts.label, { color, fontWeight: focused ? "700" : "400" }]}>
              {route.name}
            </Text>
          ),
          tabBarIcon: ({ focused }) => (
            <View style={[ts.iconWrap, focused && ts.iconWrapActive]}>
              <Ionicons
                name={focused ? icons.active : icons.inactive}
                size={22}
                color={focused ? Colors.white : Colors.textSecondary}
              />
            </View>
          ),
        };
      }}
    >
      <Tab.Screen name="Home"      component={HomeStack} />
      <Tab.Screen name="Inventory" component={InventoryStack} />
      <Tab.Screen name="Scan"      component={ScannerScreen} />
      <Tab.Screen name="Tracker"   component={DoseTrackerScreen} />
      <Tab.Screen name="Profile"   component={ProfileScreen} />
    </Tab.Navigator>
  );
}

const ts = StyleSheet.create({
  bar: {
    height: 88,
    paddingBottom: 8,
    paddingTop: 6,
    backgroundColor: Colors.white,
    borderTopWidth: 1,
    borderTopColor: "#F0F0F0",
    elevation: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
  },
  iconWrap: {
    width: 52,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapActive: {
    backgroundColor: Colors.primary,
  },
  label: {
    fontSize: 10,
    marginTop: 2,
  },
});
